"""Tests for :mod:`core.pixelle.grok_browser` (PR-A4.2).

These tests **do not launch a real browser**. Playwright may or may
not be installed in the CI runner; the module's public surface is
exercised purely through monkeypatching its lazy import hook.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from core.pixelle import grok_browser
from core.pixelle.grok_browser import (
    GrokBrowserUnavailable,
    GrokLoginFailed,
    GrokLoginOptions,
    grok_browser_login,
)


def test_login_rejects_blank_credentials():
    with pytest.raises(GrokLoginFailed):
        grok_browser_login("", "password")
    with pytest.raises(GrokLoginFailed):
        grok_browser_login("user@example.com", "")


def test_login_raises_unavailable_when_playwright_missing(monkeypatch):
    """Lazy import returning a friendly error when Playwright is absent."""

    def _missing():
        raise GrokBrowserUnavailable("Playwright not installed.")

    monkeypatch.setattr(grok_browser, "_import_playwright", _missing)

    with pytest.raises(GrokBrowserUnavailable):
        grok_browser_login("u@x.ai", "pw")


def test_login_options_defaults():
    o = GrokLoginOptions()
    # Defaults to a windowed Chromium because Cloudflare challenges
    # every headless one that hits accounts.x.ai/sign-in.
    assert o.headless is False
    assert o.timeout_ms > 0
    assert o.request_wait_ms > 0


def _build_fake_playwright():
    """Return a (sync_playwright_factory, browser, context, page) tuple
    mimicking Playwright's sync API closely enough for the login flow.
    """
    page = MagicMock()
    page.locator.return_value.count.return_value = 1
    page.locator.return_value.first.is_visible.return_value = True

    cookies = [
        {"name": "sso", "value": "abc", "domain": ".grok.com"},
        {"name": "auth_token", "value": "xyz", "domain": ".x.ai"},
        {"name": "tracker", "value": "nope", "domain": ".other.example"},
    ]
    context = MagicMock()
    context.new_page.return_value = page
    context.cookies.return_value = cookies

    browser = MagicMock()
    browser.new_context.return_value = context

    chromium = MagicMock()
    chromium.launch.return_value = browser

    playwright_obj = MagicMock()
    playwright_obj.chromium = chromium

    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=playwright_obj)
    cm.__exit__ = MagicMock(return_value=False)

    sync_playwright = MagicMock(return_value=cm)
    return sync_playwright, browser, context, page


def test_login_success_returns_session_with_cookies(monkeypatch):
    sp, browser, context, page = _build_fake_playwright()
    monkeypatch.setattr(grok_browser, "_import_playwright", lambda: sp)

    sess = grok_browser_login("user@example.com", "secret")

    # Cookies for grok.com / x.ai survive; foreign domain is dropped.
    assert sess.cookies == {"sso": "abc", "auth_token": "xyz"}
    assert sess.email == "user@example.com"
    assert "User-Agent" in sess.headers
    assert sess.headers.get("Origin", "").startswith("https://grok.com")
    browser.close.assert_called()


def test_login_failure_when_no_cookies_captured(monkeypatch):
    sp, _, context, _ = _build_fake_playwright()
    context.cookies.return_value = []  # nothing usable
    monkeypatch.setattr(grok_browser, "_import_playwright", lambda: sp)

    with pytest.raises(GrokLoginFailed, match="no grok.com cookies"):
        grok_browser_login("u@x.ai", "pw")


def test_login_unavailable_when_chromium_binary_missing(monkeypatch):
    """``chromium.launch`` raising → translated to GrokBrowserUnavailable."""
    sp, _, _, _ = _build_fake_playwright()

    # Override chromium.launch to raise.
    cm_obj = sp.return_value
    pw_obj = cm_obj.__enter__.return_value
    pw_obj.chromium.launch.side_effect = Exception(
        "Executable doesn't exist"
    )

    monkeypatch.setattr(grok_browser, "_import_playwright", lambda: sp)

    with pytest.raises(GrokBrowserUnavailable, match="Chromium"):
        grok_browser_login("u@x.ai", "pw")


def test_login_email_input_missing_raises_login_failed(monkeypatch):
    sp, _, _, page = _build_fake_playwright()
    # Make every locator report 0 count → no email input found.
    page.locator.return_value.count.return_value = 0
    monkeypatch.setattr(grok_browser, "_import_playwright", lambda: sp)

    with pytest.raises(GrokLoginFailed, match="email input"):
        grok_browser_login("u@x.ai", "pw")

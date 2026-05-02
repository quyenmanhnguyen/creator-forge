"""Offline tests for ``POST /admin/shutdown``.

The shutdown endpoint is called by ``desktop/electron/researchSidecar.js``
during ``restart({ extraEnv })`` so newly saved API keys actually reach
the running uvicorn process. Without it the desktop's ``restart()``
would hit the probe-and-reuse path and silently drop the new env, which
is the bug behind "DEEPSEEK_API_KEY not set" warnings persisting after
Save in the API-keys dialog.

We can't easily verify ``os._exit(0)`` actually fires (it would tear
down the test runner), so instead we monkeypatch ``os._exit`` to a
no-op recorder, install an ASGI middleware that pins the client
scope to either localhost or non-localhost, and assert the response
shape from each branch.
"""
from __future__ import annotations

import asyncio
import os as os_mod

from fastapi.testclient import TestClient

from research.api.main import create_app


def _wrap_with_client_host(app, host: str, port: int = 12345):
    """Return an ASGI app that pins ``request.client.host`` to ``host``
    before delegating. Used so each test exercises a deterministic
    localhost vs non-localhost branch without depending on TestClient's
    default scope (which uses ``client = ("testclient", 50000)``).
    """
    async def _wrapped(scope, receive, send):
        if scope.get("type") == "http":
            scope = dict(scope)
            scope["client"] = (host, port)
        await app(scope, receive, send)

    return _wrapped


def test_admin_shutdown_route_exists() -> None:
    """The POST /admin/shutdown route is registered on create_app()."""
    app = create_app()
    paths = {route.path for route in app.routes}
    assert "/admin/shutdown" in paths, (
        f"/admin/shutdown not registered. Routes: {sorted(paths)}"
    )


def test_admin_shutdown_localhost_returns_shutting_down(monkeypatch) -> None:
    """A request from 127.0.0.1 receives a 200 with ``shutting_down: true``
    and schedules a delayed exit task. The exit itself is captured by a
    monkeypatched ``os._exit`` so the test runner stays alive."""
    captured_exits: list[int] = []
    monkeypatch.setattr(os_mod, "_exit", lambda code=0: captured_exits.append(code))

    # Make the asyncio.sleep inside _delayed_exit no-op so the task
    # resolves quickly enough that we *could* observe captured_exits in
    # a follow-up assertion if we wanted to (but we don't gate on it
    # since the task may run after the response returns).
    real_sleep = asyncio.sleep

    async def _instant_sleep(_seconds: float) -> None:
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", _instant_sleep)

    app = create_app()
    client = TestClient(_wrap_with_client_host(app, "127.0.0.1"))
    response = client.post("/admin/shutdown")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {"ok": True, "shutting_down": True}


def test_admin_shutdown_blocks_non_localhost(monkeypatch) -> None:
    """A request whose ``client.host`` is outside the localhost set
    returns 403 and does NOT schedule an exit."""
    captured_exits: list[int] = []
    monkeypatch.setattr(os_mod, "_exit", lambda code=0: captured_exits.append(code))

    app = create_app()
    # 198.51.100.7 is in TEST-NET-2 (RFC 5737) — guaranteed never to be
    # a real route, so this is a safe non-localhost stand-in.
    client = TestClient(_wrap_with_client_host(app, "198.51.100.7"))
    response = client.post("/admin/shutdown")

    assert response.status_code == 403, response.text
    body = response.json()
    assert body.get("ok") is False
    assert "localhost" in body.get("error", "").lower()
    # The forbidden branch must not call os._exit.
    assert captured_exits == []


def test_admin_shutdown_blocks_when_client_is_none(monkeypatch) -> None:
    """A request with no client tuple (rare, but possible behind certain
    proxies) is treated as non-localhost and rejected."""
    captured_exits: list[int] = []
    monkeypatch.setattr(os_mod, "_exit", lambda code=0: captured_exits.append(code))

    app = create_app()

    async def _strip_client(scope, receive, send):
        if scope.get("type") == "http":
            scope = dict(scope)
            scope["client"] = None
        await app(scope, receive, send)

    client = TestClient(_strip_client)
    response = client.post("/admin/shutdown")

    assert response.status_code == 403, response.text
    body = response.json()
    assert body.get("ok") is False
    assert captured_exits == []


def test_admin_shutdown_accepts_ipv6_loopback(monkeypatch) -> None:
    """``::1`` (IPv6 loopback) is also part of the allowlist, so dual-
    stack environments don't lock the desktop manager out."""
    captured_exits: list[int] = []
    monkeypatch.setattr(os_mod, "_exit", lambda code=0: captured_exits.append(code))

    real_sleep = asyncio.sleep

    async def _instant_sleep(_seconds: float) -> None:
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", _instant_sleep)

    app = create_app()
    client = TestClient(_wrap_with_client_host(app, "::1"))
    response = client.post("/admin/shutdown")

    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "shutting_down": True}

"""Tests for core.pixelle.comfy_client (endpoint resolution + RH payload shape)."""
from __future__ import annotations

import pytest
import requests

from core.pixelle import comfy_client
from core.pixelle.config import ComfyUIConfig


class _FakeResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


def test_resolve_picks_local_when_alive(monkeypatch):
    cfg = ComfyUIConfig(local_url="http://127.0.0.1:8188")

    monkeypatch.setattr(
        comfy_client.requests, "get", lambda *a, **kw: _FakeResponse(200)
    )

    ep = comfy_client.resolve_endpoint(cfg, timeout=0.1)

    assert ep.kind == "local"
    assert ep.base_url == "http://127.0.0.1:8188"


def test_resolve_falls_back_to_cloud_when_local_dead(monkeypatch):
    cfg = ComfyUIConfig(local_url="http://127.0.0.1:8188")
    monkeypatch.setenv("RUNNINGHUB_API_KEY", "rh-test-key")

    def _down(*_args, **_kwargs):
        raise requests.RequestException("connection refused")

    monkeypatch.setattr(comfy_client.requests, "get", _down)

    ep = comfy_client.resolve_endpoint(cfg, timeout=0.1)

    assert ep.kind == "runninghub"
    assert ep.base_url == cfg.runninghub_base_url


def test_resolve_raises_when_neither_available(monkeypatch):
    cfg = ComfyUIConfig(local_url="http://127.0.0.1:8188")
    monkeypatch.delenv("RUNNINGHUB_API_KEY", raising=False)

    def _down(*_args, **_kwargs):
        raise requests.RequestException("connection refused")

    monkeypatch.setattr(comfy_client.requests, "get", _down)

    with pytest.raises(comfy_client.ComfyUIError, match="not reachable"):
        comfy_client.resolve_endpoint(cfg, timeout=0.1)


def test_resolve_cloud_only_skips_local_probe(monkeypatch):
    cfg = ComfyUIConfig(local_url="http://127.0.0.1:8188", cloud_only=True)
    monkeypatch.setenv("RUNNINGHUB_API_KEY", "rh-test-key")

    called = {"get": 0}

    def _spy(*_args, **_kwargs):
        called["get"] += 1
        return _FakeResponse(200)

    monkeypatch.setattr(comfy_client.requests, "get", _spy)

    ep = comfy_client.resolve_endpoint(cfg, timeout=0.1)

    assert ep.kind == "runninghub"
    assert called["get"] == 0  # didn't even probe local


def test_to_node_info_list_flattens_correctly():
    inputs = {
        "10": {"text": "hello", "seed": 42},
        "23": {"image": "cat.png"},
    }

    out = comfy_client._to_node_info_list(inputs)

    assert sorted(out, key=lambda x: (x["nodeId"], x["fieldName"])) == [
        {"nodeId": "10", "fieldName": "seed", "fieldValue": 42},
        {"nodeId": "10", "fieldName": "text", "fieldValue": "hello"},
        {"nodeId": "23", "fieldName": "image", "fieldValue": "cat.png"},
    ]

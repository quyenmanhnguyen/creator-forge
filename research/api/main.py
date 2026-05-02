"""FastAPI entrypoint for the research sidecar.

Run standalone for development::

    cd <repo>
    uvicorn research.api.main:app --host 127.0.0.1 --port 5050 --reload

The Electron desktop spawns this process via ``desktop/electron/researchSidecar.js``
and only talks to ``http://127.0.0.1:<port>`` from the main process.
"""
from __future__ import annotations

import asyncio
import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from research.api.routes import cloner, keywords, outlier, producer, research as niche, studio

logger = logging.getLogger("creator_forge.research")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def create_app() -> FastAPI:
    app = FastAPI(
        title="creator-forge research sidecar",
        version="0.1.0",
        description=(
            "HTTP API exposing the Tube-Atlas pipeline (niche, keywords, outlier, "
            "cloner, studio, producer) to the Electron desktop shell."
        ),
    )

    # Renderer never calls us directly (only main process does), so CORS is loose
    # by design. Tighten if you ever expose this beyond localhost.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )

    app.include_router(niche.router, prefix="/research", tags=["research"])
    app.include_router(keywords.router, prefix="/research", tags=["research"])
    app.include_router(outlier.router, prefix="/research", tags=["research"])
    app.include_router(cloner.router, prefix="/research", tags=["research"])
    app.include_router(studio.router, prefix="/studio", tags=["studio"])
    app.include_router(producer.router, prefix="/producer", tags=["producer"])

    @app.get("/healthz")
    def healthz() -> dict:
        return {
            "ok": True,
            "service": "creator-forge.research",
            "version": app.version,
            "youtube_key": bool(os.getenv("YOUTUBE_API_KEY")),
            "deepseek_key": bool(os.getenv("DEEPSEEK_API_KEY")),
        }

    @app.get("/")
    def root() -> dict:
        return {"status": "ok", "see": "/docs"}

    @app.post("/admin/shutdown")
    async def admin_shutdown(request: Request) -> JSONResponse:
        """Force the sidecar process to exit.

        Used by ``desktop/electron/researchSidecar.js`` so a Settings ⚙
        Save (which calls ``restart({ extraEnv })`` to apply the freshly
        saved API keys) can swap out an externally-launched uvicorn —
        e.g. one orphaned from a previous Electron run that crashed
        before its ``before-quit`` handler killed the child, or a dev's
        long-running ``uvicorn ... --reload`` in a separate terminal.
        Without this endpoint the desktop's ``restart()`` would re-take
        the probe-and-reuse path and silently drop the new ``extraEnv``,
        leaving requests to fail with ``DEEPSEEK_API_KEY not set``.

        Restricted to localhost — uvicorn already only binds 127.0.0.1
        but we re-check ``request.client.host`` as belt-and-braces in
        case a future deployment loosens the host config.
        """
        client = request.client
        host = client.host if client is not None else None
        if host not in {"127.0.0.1", "::1", "localhost"}:
            return JSONResponse(
                status_code=403,
                content={"ok": False, "error": "shutdown only allowed from localhost"},
            )

        # Schedule the exit ~200ms in the future so the response actually
        # flushes back to the caller before the event loop goes away.
        async def _delayed_exit() -> None:
            await asyncio.sleep(0.2)
            os._exit(0)

        asyncio.create_task(_delayed_exit())
        return JSONResponse(content={"ok": True, "shutting_down": True})

    return app


app = create_app()

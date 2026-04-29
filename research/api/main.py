"""FastAPI entrypoint for the research sidecar.

Run standalone for development::

    cd <repo>
    uvicorn research.api.main:app --host 127.0.0.1 --port 5050 --reload

The Electron desktop spawns this process via ``desktop/electron/researchSidecar.js``
and only talks to ``http://127.0.0.1:<port>`` from the main process.
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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

    return app


app = create_app()

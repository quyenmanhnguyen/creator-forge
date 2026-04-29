"""creator-forge research backend (FastAPI sidecar).

Replaces the Streamlit multi-page UI of tube-atlas-oss with a thin HTTP API
that the Electron desktop calls into. Business logic stays in
``research.core`` and ``research.core.pixelle`` unchanged.
"""

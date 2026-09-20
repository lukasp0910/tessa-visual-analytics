"""Main FastAPI application setup for neural dynamics visualization backend."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.v1.router import api_router
from app.core.cors import setup_cors
from app.services.registry import ensure_projects_available
from app.storage import project_storage

app = FastAPI(title="Neural Dynamics API")

setup_cors(app)

app.include_router(api_router, prefix="/api/v1")

frontend_dir = Path(__file__).resolve().parents[2] / "frontend"
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


@app.on_event("startup")
async def preload_projects() -> None:
    """Load previously stored projects from disk into memory on startup."""
    project_storage.cleanup_stale_project_directories()
    ensure_projects_available(
        item["name"] for item in project_storage.list_files()
    )

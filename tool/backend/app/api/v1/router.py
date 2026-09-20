"""API router configuration for v1 endpoints."""

from fastapi import APIRouter

from app.api.routes import chart_types

from . import (
    array_actions,
    charts,
    project_updates,
    sheets,
    statistics,
    ui_state,
    uploads,
)

api_router = APIRouter()
api_router.include_router(uploads.router, tags=["projects"])
api_router.include_router(project_updates.router, tags=["projects"])
api_router.include_router(sheets.router, tags=["sheets"])
api_router.include_router(array_actions.router, tags=["arrays"])
api_router.include_router(statistics.router, tags=["statistics"])
api_router.include_router(ui_state.router, tags=["ui"])
api_router.include_router(chart_types.router, tags=["charts"])
api_router.include_router(charts.router, tags=["charts"])

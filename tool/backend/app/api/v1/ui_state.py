"""Routes exposing UI interaction state."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.schemas.ui_state import (
    InteractionModePayload,
    InteractionModeResponse,
    ProjectSelectionPayload,
    ProjectSelectionResponse,
)
from app.services import ui_state

router = APIRouter(prefix="/ui-state", tags=["ui"])


@router.get("/interaction-mode", response_model=InteractionModeResponse)
async def get_interaction_mode() -> InteractionModeResponse:
    """Gets current interaction mode."""

    mode = ui_state.get_interaction_mode()
    return InteractionModeResponse(mode=mode)


@router.post(
    "/interaction-mode",
    response_model=InteractionModeResponse,
    status_code=status.HTTP_200_OK,
)
async def set_interaction_mode(payload: InteractionModePayload) -> InteractionModeResponse:
    """Update and return the active interaction mode."""

    try:
        mode = ui_state.set_interaction_mode(payload.mode)
    except ValueError as exc:  # pragma: no cover - defensive guard
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return InteractionModeResponse(mode=mode)


@router.get("/active-project", response_model=ProjectSelectionResponse)
async def get_active_project() -> ProjectSelectionResponse:
    """Gets last active project."""

    project_name = ui_state.get_active_project()
    return ProjectSelectionResponse(project_name=project_name)


@router.post(
    "/active-project",
    response_model=ProjectSelectionResponse,
    status_code=status.HTTP_200_OK,
)
async def set_active_project(
    payload: ProjectSelectionPayload,
) -> ProjectSelectionResponse:
    """Saves and returns active project."""

    try:
        project_name = ui_state.set_active_project(payload.project_name)
    except ValueError as exc:  # pragma: no cover - defensive guard
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ProjectSelectionResponse(project_name=project_name)

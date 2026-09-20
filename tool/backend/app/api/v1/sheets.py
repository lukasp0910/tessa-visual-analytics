"""Routes that expose sheet configuration operations."""

from __future__ import annotations

from pathlib import Path as PathlibPath

from fastapi import APIRouter, HTTPException, status

from app.schemas.sheets import (
    SheetActiveCardUpdateRequest,
    SheetActiveUpdateRequest,
    SheetCreateRequest,
    SheetListResponse,
    SheetUpdateRequest,
)
from app.storage import project_storage
from app.services import processing as processing_service
from processing import scatterplot


router = APIRouter(prefix="/projects/{project_id}/sheets")


def _ensure_project_exists(project_name: str) -> str:
    safe_name = PathlibPath(project_name).name
    if not project_storage.file_exists(safe_name):
        directory = project_storage.project_directory(safe_name)
        if not directory.exists():
            raise HTTPException(status_code=404, detail="Project not found")
    return safe_name


def _build_sheet_response(config: dict) -> SheetListResponse:
    sheets = config.get("sheets", [])
    last_active = config.get("lastActiveSheetId")
    return SheetListResponse(sheets=sheets, lastActiveSheetId=last_active)


@router.get("", response_model=SheetListResponse)
async def list_sheets(project_id: str):
    """Gets sheet config for project."""

    project_name = _ensure_project_exists(project_id)
    config = project_storage.ensure_sheet_config(project_name)
    return _build_sheet_response(config)


@router.post("", response_model=SheetListResponse, status_code=status.HTTP_201_CREATED)
async def create_sheet(project_id: str, payload: SheetCreateRequest):
    """Create a new sheet for the provided project."""

    project_name = _ensure_project_exists(project_id)
    project_storage.add_sheet(
        project_name,
        name=payload.name,
        row_count=payload.row_count,
        column_count=payload.column_count,
    )
    config = project_storage.ensure_sheet_config(project_name)
    return _build_sheet_response(config)


@router.patch("/{sheet_id}", response_model=SheetListResponse)
async def update_sheet(project_id: str, sheet_id: str, payload: SheetUpdateRequest):
    """Update metadata for the selected sheet."""

    project_name = _ensure_project_exists(project_id)
    cards_payload = None
    if payload.cards is not None:
        cards_payload = [card.dict(by_alias=True) for card in payload.cards]
        for card in cards_payload:
            configuration = card.get("configuration")
            if not isinstance(configuration, dict):
                continue
            chart_type = str(
                configuration.get("chartType") or configuration.get("chart_type") or ""
            ).strip()
            if chart_type.lower() != "scatter":
                continue
            try:
                scatterplot.parse_card_configuration(configuration)
            except scatterplot.ScatterConfigurationError as exc:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "INVALID_SCATTER_CONFIGURATION",
                        "message": str(exc) or "Scatter plot configuration is invalid.",
                    },
                ) from exc

    try:
        updated_sheet = project_storage.update_sheet(
            project_name,
            sheet_id,
            name=payload.name,
            cards=cards_payload,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Sheet not found") from exc
    processing_service.handle_sheet_update(
        project_name,
        updated_sheet,
    )
    config = project_storage.ensure_sheet_config(project_name)
    return _build_sheet_response(config)


@router.put("/{sheet_id}/active-card", response_model=SheetListResponse)
async def set_active_card(
    project_id: str, sheet_id: str, payload: SheetActiveCardUpdateRequest
):
    """Store the identifier for the sheet's last active card."""

    project_name = _ensure_project_exists(project_id)
    try:
        project_storage.set_last_active_card(
            project_name, sheet_id, payload.card_id
        )
    except KeyError as exc:
        message = exc.args[0] if exc.args else "Sheet not found"
        detail = "Card not found" if isinstance(message, str) and "Card" in message else "Sheet not found"
        raise HTTPException(status_code=404, detail=detail) from exc
    config = project_storage.ensure_sheet_config(project_name)
    return _build_sheet_response(config)


@router.delete("/{sheet_id}", response_model=SheetListResponse)
async def delete_sheet(project_id: str, sheet_id: str):
    """Remove the selected sheet from the project configuration."""

    project_name = _ensure_project_exists(project_id)
    try:
        project_storage.delete_sheet(project_name, sheet_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Sheet not found") from exc
    config = project_storage.ensure_sheet_config(project_name)
    return _build_sheet_response(config)


@router.put("/active", response_model=SheetListResponse)
async def set_active_sheet(project_id: str, payload: SheetActiveUpdateRequest):
    """Store the identifier for the project's last active sheet."""

    project_name = _ensure_project_exists(project_id)
    try:
        project_storage.set_last_active_sheet(project_name, payload.sheet_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Sheet not found") from exc
    config = project_storage.ensure_sheet_config(project_name)
    return _build_sheet_response(config)

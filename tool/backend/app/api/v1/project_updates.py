"""Project level update routes."""

from __future__ import annotations

from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path as PathlibPath
from typing import Dict

import numpy as np
from fastapi import APIRouter, HTTPException, status

from app.api.v1.utils import project_update_response
from app.schemas.projects import (
    ProjectCreateRequest,
    ProjectUpdateRequest,
    ProjectVisibility,
)
from app.services import metadata, registry, subjects, time_axis, visibility
from app.storage import project_storage


router = APIRouter(prefix="/projects")


@router.get("/{project_id}")
async def retrieve_project_metadata(project_id: str):
    """Gets project metadata and visibility."""

    project_name = PathlibPath(project_id).name
    summary = metadata.project_summary(project_name)
    if summary is None:
        raise HTTPException(status_code=404, detail="Project not found")

    title = summary.get("title") or project_storage.project_display_name(project_name)
    payload: Dict[str, object] = {
        "name": project_name,
        "file_name": summary.get("file_name") or project_name,
        "filename": summary.get("file_name") or project_name,
        "title": title,
        "project": project_name,
        "description": summary.get("description"),
        "array_count": summary.get("array_count", 0),
        "arrays": summary.get("arrays", []),
        "visibility": summary.get("visibility"),
        "time_axis": summary.get("time_axis"),
        "time_axis_conflicts": summary.get("time_axis_conflicts", []),
        "time_controls": summary.get("time_controls"),
        "subject_mode": summary.get("subject_mode"),
        "subject_arrays": summary.get("subject_arrays", []),
        "subject_names": summary.get("subject_names", {}),
    }

    if summary.get("created_at") is not None:
        payload["created_at"] = summary.get("created_at")
    if summary.get("project_id") is not None:
        payload["project_id"] = summary.get("project_id")

    return payload


@router.get("/{project_id}/subjects")
async def retrieve_project_subject_groups(project_id: str):
    """Gets detected subject groups."""

    project_name = PathlibPath(project_id).name
    try:
        summary = subjects.analyze_subject_groups(project_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc

    return summary


@router.delete("/{project_id}")
async def delete_uploaded_file(project_id: str):
    """Delete an uploaded project from disk and memory."""

    deleted_from_disk, deletion_details = project_storage.delete_file(project_id)
    removed_from_memory = registry.delete_project(PathlibPath(project_id).name)
    deleted_visibility = project_storage.delete_visibility_config(project_id)

    removed_directory = deletion_details.get("removed_directory", False)
    removed_assets = (
        deletion_details.get("removed_archive", False)
        or deletion_details.get("removed_manifest", False)
        or deletion_details.get("removed_visibility_legacy", False)
        or deletion_details.get("removed_visibility_flat", False)
    )
    removed_from_disk = removed_assets or removed_directory

    if not (deleted_from_disk or removed_from_memory):
        raise HTTPException(status_code=404, detail="File not found")

    return {
        "filename": PathlibPath(project_id).name,
        "deleted": True,
        "removed_from_disk": removed_from_disk,
        "removed_from_memory": removed_from_memory,
        "removed_visibility": deleted_visibility,
        "removed_directory": removed_directory,
    }


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_project(payload: ProjectCreateRequest):
    """Create a new, empty project directory with metadata."""

    file_name = PathlibPath(payload.name).name

    if project_storage.file_exists(file_name):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A project with this name already exists.",
        )

    arrays_data: OrderedDict[str, np.ndarray] = OrderedDict()
    project_storage.write_npz(file_name, arrays_data)
    registry.store_project(file_name, arrays_data)
    project_storage.ensure_project_manifest(file_name, arrays_data)

    created_at = datetime.now(timezone.utc).isoformat()
    project_storage.save_project_info(
        file_name,
        {
            "name": project_storage.project_display_name(file_name),
            "file_name": file_name,
            "description": payload.description,
            "created_at": created_at,
            "subject_mode": "single",
        },
    )

    project_storage.ensure_project_manifest(file_name, arrays_data)
    project_storage.ensure_sheet_config(file_name)

    summary = metadata.project_summary(file_name)

    response: Dict[str, object] = {
        "project": file_name,
        "description": payload.description,
        "created_at": created_at,
        "array_count": 0,
        "arrays": [],
        "time_axis": None,
        "time_axis_conflicts": [],
        "time_controls": None,
        "subject_mode": "single",
    }

    if summary is not None:
        response["array_count"] = summary.get("array_count", 0)
        response["arrays"] = summary.get("arrays", [])
        if summary.get("visibility") is not None:
            response["visibility"] = summary["visibility"]
        if summary.get("project_id") is not None:
            response["project_id"] = summary["project_id"]
        if "time_axis" in summary:
            response["time_axis"] = summary.get("time_axis")
        if summary.get("time_axis_conflicts") is not None:
            response["time_axis_conflicts"] = summary.get("time_axis_conflicts", [])
        if "time_controls" in summary:
            response["time_controls"] = summary.get("time_controls")

    return response


@router.put("/{project_id}/visibility")
async def update_visibility(project_id: str, payload: ProjectVisibility):
    """Update the visibility configuration for arrays and their columns."""

    project_name = PathlibPath(project_id).name
    try:
        visibility.update_project_visibility(project_name, payload)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc

    return project_update_response(project_name)


@router.put("/{project_id}")
async def update_project(project_id: str, payload: ProjectUpdateRequest):
    """Rename a project and/or update its visibility configuration."""

    project_name = PathlibPath(project_id).name
    target_name = project_name

    if payload.name is not None:
        try:
            target_name = registry.rename_project(project_name, payload.name)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc
        except FileExistsError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A project with this name already exists.",
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        project_name = target_name

    if payload.visibility is not None:
        try:
            visibility.update_project_visibility(project_name, payload.visibility)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Project not found") from exc

    if "time_axis" in payload.__fields_set__:
        arrays = registry.get_project(project_name)
        if arrays is None and not registry.load_project_from_disk(project_name):
            raise HTTPException(status_code=404, detail="Project not found")
        arrays = registry.get_project(project_name)
        if arrays is None:
            raise HTTPException(status_code=404, detail="Project not found")

        config = (
            payload.time_axis.dict(exclude_unset=True)
            if payload.time_axis is not None
            else None
        )

        try:
            time_axis.update_project_time_axis(project_name, config, arrays=arrays)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    if "time_controls" in payload.__fields_set__:
        config = (
            payload.time_controls.dict(exclude_unset=True)
            if payload.time_controls is not None
            else None
        )
        if not project_storage.file_exists(project_name):
            raise HTTPException(status_code=404, detail="Project not found")
        try:
            project_storage.save_time_controls(project_name, config)
        except FileNotFoundError as exc:  # pragma: no cover - defensive guard
            raise HTTPException(status_code=404, detail="Project not found") from exc

    if "subject_mode" in payload.__fields_set__:
        if not project_storage.file_exists(project_name):
            raise HTTPException(status_code=404, detail="Project not found")
        mode_value = payload.subject_mode or "single"
        try:
            project_storage.update_project_info(
                project_name,
                {"subject_mode": mode_value},
            )
        except FileNotFoundError as exc:  # pragma: no cover - defensive guard
            raise HTTPException(status_code=404, detail="Project not found") from exc

    if "subject_arrays" in payload.__fields_set__:
        if not project_storage.file_exists(project_name):
            raise HTTPException(status_code=404, detail="Project not found")
        manifest = project_storage.ensure_project_manifest(project_name)
        normalized_ids = subjects.normalize_subject_array_ids(
            payload.subject_arrays,
            manifest,
        )
        try:
            project_storage.update_project_info(
                project_name,
                {"subject_arrays": normalized_ids},
            )
        except FileNotFoundError as exc:  # pragma: no cover - defensive guard
            raise HTTPException(status_code=404, detail="Project not found") from exc

    if "subject_names" in payload.__fields_set__:
        if not project_storage.file_exists(project_name):
            raise HTTPException(status_code=404, detail="Project not found")
        normalized_names = subjects.normalize_subject_name_map(payload.subject_names or {})
        try:
            project_storage.update_project_info(
                project_name,
                {"subject_names": normalized_names},
            )
        except FileNotFoundError as exc:  # pragma: no cover - defensive guard
            raise HTTPException(status_code=404, detail="Project not found") from exc

    return project_update_response(project_name)


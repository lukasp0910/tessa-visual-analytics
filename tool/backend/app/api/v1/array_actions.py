"""Array specific API routes."""

from __future__ import annotations

from collections import OrderedDict
from io import BytesIO
from pathlib import Path as PathlibPath
from typing import Dict, List

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status

from app.api.v1.utils import load_npz_arrays, project_update_response, resolve_project_array
from app.schemas.projects import ArrayUpdateRequest
from app.services import arrays as arrays_service, metadata, registry, visibility
from app.storage import project_storage


router = APIRouter(prefix="/projects")


@router.get("/{project_id}/arrays")
async def list_project_arrays(project_id: str):
    """Lists arrays in project."""

    project_name = PathlibPath(project_id).name
    summary = metadata.project_summary(project_name)
    if summary is None:
        raise HTTPException(status_code=404, detail="Project not found")

    arrays = summary.get("arrays")
    if not isinstance(arrays, list):
        return []
    return arrays


@router.get("/{project_id}/arrays/{array_id}")
async def preview_array(
    project_id: str,
    array_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(10, ge=1, le=metadata.MAX_PREVIEW_ROWS),
):
    """Gets array preview for UI table."""

    project_name, array_entry, array = resolve_project_array(project_id, array_id)

    preview = metadata.array_preview(array, offset=offset, limit=limit)
    column_names = visibility.array_column_names(project_name, array_id)
    if column_names:
        preview["columns"] = metadata.apply_column_names(
            preview.get("columns", []), column_names
        )
    preview.update(
        {
            "id": array_entry.get("id"),
            "name": array_entry.get("name"),
            "shape": [int(dim) for dim in array.shape],
            "dtype": str(array.dtype),
        }
    )

    return preview


@router.post("/{project_id}/arrays", status_code=status.HTTP_201_CREATED)
async def append_array_to_project(
    project_id: str,
    file: UploadFile = File(...),
    array_name: str = Form(None),
):
    """Add a new array from an uploaded NPY file to an existing project."""

    project_name = PathlibPath(project_id).name

    if PathlibPath(project_name).suffix.lower() != ".npz":
        raise HTTPException(status_code=400, detail="Target project must be an NPZ archive.")

    binary = await file.read()
    if not binary:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    filename = PathlibPath(file.filename or "array.npy").name
    if PathlibPath(filename).suffix.lower() != ".npy":
        raise HTTPException(status_code=400, detail="Only NPY files can be appended.")

    derived_name = (array_name or "").strip()
    if not derived_name:
        derived_name = filename[:-4] if filename.lower().endswith(".npy") else filename
    derived_name = derived_name.replace("\\", "/").split("/")[-1].strip()

    if not derived_name:
        raise HTTPException(status_code=400, detail="Array name cannot be empty.")

    try:
        npy_array = _load_npy_array(binary)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Failed to read NPY file.") from exc

    existing = registry.get_project(project_name)
    existing_names = set(existing.keys()) if existing else set()

    try:
        updated = arrays_service.append_arrays(
            project_name, OrderedDict([(derived_name, npy_array)])
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc
    except arrays_service.ArrayAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail="An array with this name already exists.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    response = project_update_response(project_name)
    manifest = project_storage.ensure_project_manifest(project_name, updated)
    new_names = [name for name in updated.keys() if name not in existing_names]
    added_entries = []
    for name in new_names:
        entry = project_storage.find_array_entry_by_name(manifest, name)
        if entry:
            added_entries.append({"id": entry.get("id"), "name": entry.get("name")})
    if added_entries:
        response["added_arrays"] = added_entries
    return response


@router.post("/{project_id}/arrays/import", status_code=status.HTTP_201_CREATED)
async def append_archive_to_project(project_id: str, file: UploadFile = File(...)):
    """Merge arrays from an NPZ archive into an existing project."""

    project_name = PathlibPath(project_id).name

    if PathlibPath(project_name).suffix.lower() != ".npz":
        raise HTTPException(status_code=400, detail="Target project must be an NPZ archive.")

    binary = await file.read()
    if not binary:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    filename = PathlibPath(file.filename or "archive.npz").name
    if PathlibPath(filename).suffix.lower() != ".npz":
        raise HTTPException(status_code=400, detail="Only NPZ files can be appended.")

    try:
        arrays = load_npz_arrays(binary)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid NPZ archive.") from exc

    if not arrays:
        raise HTTPException(status_code=400, detail="Archive does not contain any arrays.")

    existing = registry.get_project(project_name)
    existing_names = set(existing.keys()) if existing else set()

    try:
        updated = arrays_service.append_arrays(project_name, arrays)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc
    except arrays_service.ArrayAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail="An array with this name already exists.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    response = project_update_response(project_name)
    manifest = project_storage.ensure_project_manifest(project_name, updated)
    new_names = [name for name in updated.keys() if name not in existing_names]
    added_entries: List[Dict[str, object]] = []
    for name in new_names:
        entry = project_storage.find_array_entry_by_name(manifest, name)
        if entry:
            added_entries.append({"id": entry.get("id"), "name": entry.get("name")})
    if added_entries:
        response["added_arrays"] = added_entries
    return response


@router.patch("/{project_id}/arrays/{array_id}")
async def update_array_metadata(project_id: str, array_id: str, payload: ArrayUpdateRequest):
    """Rename an array and/or update its column labels."""

    project_name = PathlibPath(project_id).name

    if payload.name is None and payload.column_names is None:
        raise HTTPException(status_code=400, detail="No updates requested.")

    try:
        target_array_name = None
        if payload.name is not None:
            target_array_name = arrays_service.rename_array(project_name, array_id, payload.name)

        if payload.column_names is not None:
            visibility.update_array_column_names(project_name, array_id, payload.column_names)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc
    except arrays_service.ArrayNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Array not found") from exc
    except arrays_service.ArrayAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail="An array with this name already exists.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    manifest = project_storage.ensure_project_manifest(project_name)
    entry = project_storage.find_array_entry_by_id(manifest, array_id)
    response = project_update_response(project_name)
    response["array"] = {
        "id": array_id,
        "name": entry.get("name") if isinstance(entry, dict) else target_array_name,
    }
    return response


@router.delete("/{project_id}/arrays/{array_id}")
async def remove_array(project_id: str, array_id: str):
    """Delete an array from a project."""

    project_name = PathlibPath(project_id).name

    try:
        arrays_service.delete_array(project_name, array_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc
    except arrays_service.ArrayNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Array not found") from exc

    response = project_update_response(project_name)
    response["deleted_array"] = array_id
    return response


def _load_npy_array(binary: bytes) -> np.ndarray:
    """Load a single array stored in NPY format."""

    buffer = BytesIO(binary)
    try:
        array = np.load(buffer, allow_pickle=False)
    except (OSError, ValueError) as exc:
        raise ValueError("Invalid NPY array") from exc

    if not isinstance(array, np.ndarray):
        array = np.array(array)

    return np.array(array)


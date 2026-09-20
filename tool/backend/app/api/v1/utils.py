"""Utility helpers shared across API routers."""

from __future__ import annotations

from collections import OrderedDict
from io import BytesIO
from pathlib import Path as PathlibPath
from typing import Dict, Tuple
from zipfile import BadZipFile

import numpy as np
from fastapi import HTTPException

from app.services import metadata, registry
from app.storage import project_storage


def load_npz_arrays(binary: bytes) -> "OrderedDict[str, np.ndarray]":
    """Load arrays from an NPZ archive stored in memory."""

    buffer = BytesIO(binary)
    try:
        with np.load(buffer, allow_pickle=False) as npz_file:
            arrays: "OrderedDict[str, np.ndarray]" = OrderedDict()
            for key in npz_file.files:
                arrays[key] = np.array(npz_file[key])
    except (BadZipFile, OSError, ValueError, KeyError) as exc:
        raise ValueError("Invalid NPZ archive") from exc

    return arrays


def resolve_project_array(file_name: str, array_id: str) -> Tuple[str, Dict[str, object], np.ndarray]:
    """Load and return an array from a project, ensuring it exists."""

    project_name = PathlibPath(file_name).name
    project = registry.get_project(project_name)
    if project is None:
        if not registry.load_project_from_disk(project_name):
            raise HTTPException(status_code=404, detail="Project not found")
        project = registry.get_project(project_name)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")

    manifest = project_storage.ensure_project_manifest(project_name, project)
    entry = project_storage.find_array_entry_by_id(manifest, array_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Array not found")

    array_name = entry.get("name")
    if not array_name:
        raise HTTPException(status_code=404, detail="Array not found")

    array = project.get(array_name)
    if array is None:
        raise HTTPException(status_code=404, detail="Array not found")

    return project_name, entry, array


def project_update_response(project_name: str) -> Dict[str, object]:
    """Builds response payload for project updates."""

    summary = metadata.project_summary(project_name)
    if summary is None:
        raise HTTPException(status_code=404, detail="Project not found")

    return {
        "project": project_name,
        "visibility": summary.get("visibility"),
        "arrays": summary.get("arrays", []),
        "array_count": summary.get("array_count"),
        "description": summary.get("description"),
        "created_at": summary.get("created_at"),
        "title": summary.get("title"),
        "project_id": summary.get("project_id"),
        "time_axis": summary.get("time_axis"),
        "time_axis_conflicts": summary.get("time_axis_conflicts", []),
        "time_controls": summary.get("time_controls"),
        "subject_mode": summary.get("subject_mode"),
        "subject_arrays": summary.get("subject_arrays", []),
        "subject_names": summary.get("subject_names", {}),
    }


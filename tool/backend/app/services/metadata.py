"""Metadata helpers for working with project arrays."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional

import numpy as np

from app.storage import project_storage

from . import time_axis as time_axis_service
from .common import normalize_column_name_map
from .registry import ProjectRegistry, get_project, load_project_from_disk, project_registry
from .subjects import normalize_subject_array_ids, normalize_subject_name_map
from .visibility import project_visibility

MAX_PREVIEW_ROWS = 100


def describe_arrays(
    arrays: Mapping[str, np.ndarray],
    manifest: Optional[Dict[str, Any]] = None,
):
    """Gets shape and dtype info for arrays."""

    name_lookup: Dict[str, Dict[str, Any]] = {}
    if manifest is not None:
        entries = manifest.get("arrays") if isinstance(manifest, dict) else None
        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                name = entry.get("name")
                if isinstance(name, str):
                    name_lookup[name] = entry

    description = []
    for key, array in arrays.items():
        shape = [int(dim) for dim in array.shape]
        entry = name_lookup.get(key)
        record: Dict[str, Any] = {
            "name": entry.get("name") if entry and entry.get("name") else key,
            "shape": shape,
            "dtype": str(array.dtype),
        }
        if entry and entry.get("id"):
            record["id"] = entry["id"]
        description.append(record)

    return description


def project_description(arrays: Mapping[str, np.ndarray]) -> Optional[str]:
    """Extract a human-friendly description from the metadata array if present."""

    metadata_array = arrays.get("metadata")
    if metadata_array is None:
        return None

    text = _array_to_text(metadata_array)
    if text is None:
        return None

    try:
        payload = json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None

    description = payload.get("description") if isinstance(payload, dict) else None
    if isinstance(description, str):
        description = description.strip()
        if description:
            return description
    return None


def _normalize_subject_mode(value: Any) -> str:
    """Converts subject mode to 'single' or 'multi'."""

    if isinstance(value, str):
        cleaned = value.strip().lower()
        if not cleaned:
            return "single"
        if cleaned in {"single", "single-subject"}:
            return "single"
        if cleaned in {"multi", "multi-subject"}:
            return "multi"
        normalized = cleaned.replace("_", " ").replace("-", " ")
        normalized = " ".join(normalized.split())
        if normalized in {"single subject"}:
            return "single"
        if normalized in {"multi subject", "multiple subjects"}:
            return "multi"
    if isinstance(value, bool):
        return "multi" if value else "single"
    return "single"


def project_summary(
    name: str,
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> Optional[Dict[str, object]]:
    """Loads project metadata if it exists."""

    arrays = get_project(name, registry=registry)
    if arrays is None and not load_project_from_disk(name, registry=registry, storage=storage):
        return None
    arrays = get_project(name, registry=registry)
    if arrays is None:
        return None

    manifest = storage.ensure_project_manifest(name, arrays)
    info = manifest.get("project") if isinstance(manifest, dict) else {}
    description: Optional[str] = None
    created_at: Optional[str] = None
    display_name: Optional[str] = None
    file_label: Optional[str] = None
    project_id: Optional[str] = None
    subject_mode = "single"
    friendly_name = storage.project_display_name(name)

    if isinstance(info, dict):
        project_id = str(info.get("id")) if info.get("id") else None
        raw_description = info.get("description")
        if isinstance(raw_description, str):
            trimmed = raw_description.strip()
            if trimmed:
                description = trimmed
        raw_created = info.get("created_at")
        if raw_created is not None:
            text = str(raw_created).strip()
            if text:
                created_at = text
        raw_display = info.get("name")
        if isinstance(raw_display, str):
            trimmed = raw_display.strip()
            if trimmed:
                if trimmed.lower().endswith(".npz") or trimmed == Path(name).name:
                    display_name = storage.project_display_name(trimmed)
                else:
                    display_name = trimmed
        raw_file_label = info.get("file_name")
        if isinstance(raw_file_label, str):
            trimmed = raw_file_label.strip()
            if trimmed:
                file_label = trimmed
        subject_mode = _normalize_subject_mode(info.get("subject_mode"))

    if not display_name:
        display_name = friendly_name

    if not description:
        description = project_description(arrays)

    metadata_entries = describe_arrays(arrays, manifest)
    visibility_state = project_visibility(name, arrays, storage=storage)
    stored_visibility = visibility_state.get("arrays", {}) if isinstance(visibility_state, dict) else {}
    subject_arrays: List[str] = []
    subject_names: Dict[str, str] = {}
    if isinstance(manifest, dict):
        project_section = manifest.get("project")
        if isinstance(project_section, dict):
            subject_arrays = normalize_subject_array_ids(
                project_section.get("subject_arrays"),
                manifest,
            )
            subject_names = normalize_subject_name_map(project_section.get("subject_names"))

    for entry in metadata_entries:
        array_id = entry.get("id")
        array_visibility = stored_visibility.get(array_id, {}) if array_id else {}
        enabled = bool(array_visibility.get("enabled", True))
        entry["enabled"] = enabled
        disabled_columns = array_visibility.get("disabled_columns", [])
        entry["disabled_columns"] = list(disabled_columns)
        column_names = array_visibility.get("column_names") if isinstance(array_visibility, dict) else None
        if column_names:
            entry["column_names"] = column_names

    visibility: Dict[str, Any] = {"arrays": stored_visibility}

    resolved_time_axis, time_axis_conflicts = time_axis_service.resolve_time_axis(
        name, arrays, manifest=manifest
    )
    time_controls = storage.load_time_controls(name)

    summary: Dict[str, object] = {
        "array_count": len(metadata_entries),
        "arrays": metadata_entries,
        "description": description,
        "visibility": visibility,
        "time_axis": resolved_time_axis,
        "time_axis_conflicts": time_axis_conflicts,
        "time_controls": time_controls,
        "subject_mode": subject_mode,
        "subject_arrays": subject_arrays,
        "subject_names": subject_names,
    }

    if created_at:
        summary["created_at"] = created_at
    if display_name:
        summary["title"] = display_name
    if file_label:
        summary["file_name"] = file_label
    if project_id:
        summary["project_id"] = project_id

    return summary


def array_preview(array: np.ndarray, offset: int, limit: int) -> Dict[str, object]:
    """Gets paginated 2D preview of array."""

    try:
        offset = int(offset)
    except (TypeError, ValueError):
        offset = 0
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 10

    offset = max(0, offset)
    limit = max(1, min(limit, MAX_PREVIEW_ROWS))

    if array.ndim == 0:
        values = array.reshape(1, 1).tolist()
        return {
            "offset": 0,
            "limit": 1,
            "total_rows": 1,
            "columns": ["Value"],
            "rows": values,
        }

    row_count = int(array.shape[0]) if array.ndim >= 1 else 1
    if row_count == 0:
        column_count = int(np.prod(array.shape[1:])) if array.ndim > 1 else 1
        return {
            "offset": 0,
            "limit": limit,
            "total_rows": 0,
            "columns": [f"Column {i + 1}" for i in range(column_count)] or ["Value"],
            "rows": [],
        }

    reshaped = array.reshape(row_count, -1)
    total_rows = int(reshaped.shape[0])
    column_count_value = int(reshaped.shape[1]) if reshaped.ndim == 2 else 1

    max_start = max(total_rows - limit, 0)
    start = min(offset, max_start)
    end = min(start + limit, total_rows)

    rows = reshaped[start:end].tolist()
    columns = [f"Column {i + 1}" for i in range(column_count_value)] or ["Value"]

    return {
        "offset": start,
        "limit": limit,
        "total_rows": total_rows,
        "columns": columns,
        "rows": rows,
        "column_stats": None,
    }


def apply_column_names(
    default_columns: List[str],
    custom_names: Mapping[int, str] | Iterable[object],
) -> List[str]:
    """Merge custom column name overrides with default column labels."""

    if not default_columns:
        return default_columns

    normalized = normalize_column_name_map(custom_names, limit=len(default_columns))
    if not normalized:
        return default_columns

    overrides = {index - 1: name for index, name in normalized.items() if index >= 1}

    merged = []
    for index, default in enumerate(default_columns):
        override = overrides.get(index)
        if override:
            merged.append(str(override))
        else:
            merged.append(str(default))
    return merged


def array_column_statistics(
    array: np.ndarray, column_index: int
) -> Optional[Dict[str, Optional[float]]]:
    """Calculates stats for a single column."""

    if column_index < 0:
        raise IndexError("Column index must be non-negative")

    if array.ndim == 0:
        if column_index != 0:
            raise IndexError("Column index out of range for scalar array")
        column = array.reshape(-1)
    else:
        row_count = int(array.shape[0]) if array.ndim >= 1 else 1
        column_count_value = int(np.prod(array.shape[1:])) if array.ndim > 1 else 1

        if column_index >= column_count_value:
            raise IndexError("Column index out of range")

        if row_count == 0:
            return None

        reshaped = array.reshape(row_count, column_count_value)
        column = reshaped[:, column_index]

    dtype = column.dtype
    if np.issubdtype(dtype, np.complexfloating):
        return None

    if not (np.issubdtype(dtype, np.number) or np.issubdtype(dtype, np.bool_)):
        return None

    if column.size == 0:
        return None

    float_data = column.astype(np.float64, copy=False)

    if float_data.size == 0:
        return None

    if np.isnan(float_data).all():
        return None

    with np.errstate(invalid="ignore"):
        min_val = np.nanmin(float_data)
        max_val = np.nanmax(float_data)
        mean_val = np.nanmean(float_data)
        median_val = np.nanmedian(float_data)

    def _normalize(value: float) -> Optional[float]:
        if value is None or np.isnan(value):
            return None
        try:
            python_value = float(value)
        except (TypeError, ValueError):
            return None
        if not np.isfinite(python_value):
            return None
        return python_value

    normalized_average = _normalize(mean_val)
    normalized_mean = _normalize(mean_val)
    normalized_median = _normalize(median_val)

    return {
        "min": _normalize(min_val),
        "max": _normalize(max_val),
        "average": normalized_average,
        "mean": normalized_mean,
        "median": normalized_median,
    }


def _array_to_text(array: np.ndarray) -> Optional[str]:
    """Coerce an NPZ array that stores text/JSON into a UTF-8 string."""

    scalar_candidates = []
    try:
        scalar_candidates.append(array.item())
    except ValueError:
        pass

    if array.size == 1:
        try:
            scalar_candidates.append(array.reshape(()).item())
        except ValueError:
            scalar_candidates.append(array.reshape(-1)[0])

    for candidate in scalar_candidates:
        text = _coerce_scalar_to_text(candidate)
        if text is not None:
            return text

    if array.dtype == np.uint8:
        try:
            return array.tobytes().decode("utf-8")
        except UnicodeDecodeError:
            return None

    if array.dtype.kind in {"U", "S"} and array.size >= 1:
        value = array.reshape(-1)[0]
        return str(value)

    return None


def _coerce_scalar_to_text(value) -> Optional[str]:
    """Convert a scalar candidate to a UTF-8 string when possible."""

    if isinstance(value, np.void):
        try:
            return value.tobytes().decode("utf-8")
        except UnicodeDecodeError:
            return None

    if isinstance(value, np.ndarray):
        return _array_to_text(value)

    if isinstance(value, (bytes, bytearray, memoryview, np.bytes_)):
        try:
            return bytes(value).decode("utf-8")
        except UnicodeDecodeError:
            return None

    if isinstance(value, (np.str_, str)):
        return str(value)

    return None


__all__ = [
    "MAX_PREVIEW_ROWS",
    "apply_column_names",
    "array_column_statistics",
    "array_preview",
    "describe_arrays",
    "project_description",
    "project_summary",
]


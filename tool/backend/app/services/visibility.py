"""Visibility helpers for project arrays."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Iterable, Mapping, Optional

import numpy as np

from app.schemas.projects import ProjectVisibility
from app.storage import project_storage

from .arrays import ArrayNotFoundError
from .common import column_count, normalize_column_name_map
from .registry import ProjectRegistry, get_project, load_project_from_disk, project_registry


def project_visibility(
    name: str,
    arrays: Mapping[str, np.ndarray],
    *,
    storage=project_storage,
) -> Dict[str, Dict[str, object]]:
    """Gets visibility config for project."""

    manifest = storage.ensure_project_manifest(name, arrays)
    raw_config = manifest.get("visibility") if isinstance(manifest, dict) else {}
    stored = raw_config.get("arrays") if isinstance(raw_config, dict) else {}
    if not isinstance(stored, dict):
        stored = {}

    normalized: Dict[str, Dict[str, object]] = {}
    entries = manifest.get("arrays") if isinstance(manifest, dict) else []
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            array_id = entry.get("id")
            if not array_id:
                continue
            config_entry = stored.get(array_id) if isinstance(stored, dict) else None
            enabled = (
                bool(config_entry.get("enabled", True))
                if isinstance(config_entry, dict)
                else True
            )
            columns = _normalize_disabled_columns(
                config_entry.get("disabled_columns") if isinstance(config_entry, dict) else []
            )
            payload: Dict[str, object] = {
                "enabled": enabled,
                "disabled_columns": columns,
            }
            if isinstance(config_entry, dict) and config_entry.get("column_names"):
                overrides = normalize_column_name_map(config_entry.get("column_names"))
                if overrides:
                    payload["column_names"] = {
                        str(index): name for index, name in overrides.items()
                    }
            normalized[array_id] = payload

    return {"arrays": normalized}


def update_project_visibility(
    name: str,
    payload: ProjectVisibility,
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> Dict[str, Dict[str, object]]:
    """Saves new visibility config."""

    arrays = get_project(name, registry=registry)
    if arrays is None and not load_project_from_disk(name, registry=registry, storage=storage):
        raise FileNotFoundError(f"Project {name!r} not found")

    arrays = get_project(name, registry=registry)
    if arrays is None:
        raise FileNotFoundError(f"Project {name!r} not found")

    manifest = storage.ensure_project_manifest(name, arrays)
    entries = manifest.get("arrays") if isinstance(manifest, dict) else []
    valid_ids = [entry.get("id") for entry in entries if isinstance(entry, dict) and entry.get("id")]

    normalized_payload = payload.normalized(valid_ids)
    storage.save_visibility_config(name, normalized_payload)
    storage.ensure_project_manifest(name, arrays)
    return project_visibility(name, arrays, storage=storage)


def update_array_column_names(
    project_name: str,
    array_id: str,
    column_names: Optional[Mapping[int, str] | Iterable[object]],
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> Dict[int, str]:
    """Saves custom column names for array."""

    safe_project_name = Path(project_name).name

    arrays = get_project(safe_project_name, registry=registry)
    if arrays is None and not load_project_from_disk(
        safe_project_name, registry=registry, storage=storage
    ):
        raise FileNotFoundError(f"Project {safe_project_name!r} not found")

    arrays = get_project(safe_project_name, registry=registry)
    if arrays is None:
        raise FileNotFoundError(f"Project {safe_project_name!r} not found")

    manifest = storage.ensure_project_manifest(safe_project_name, arrays)
    entry = storage.find_array_entry_by_id(manifest, array_id)
    if entry is None:
        raise ArrayNotFoundError(f"Array with id {array_id!r} not found")

    array_name = entry.get("name") or ""
    array = arrays.get(array_name)
    if array is None:
        raise ArrayNotFoundError(f"Array with id {array_id!r} not found")

    column_count_value = column_count(array)
    normalized = normalize_column_name_map(column_names, limit=column_count_value or None)

    config = storage.load_visibility_config(safe_project_name)
    arrays_config = dict(config.get("arrays", {})) if isinstance(config, dict) else {}
    entry_config = dict(arrays_config.get(array_id, {})) if isinstance(arrays_config, dict) else {}

    if normalized:
        entry_config["column_names"] = {
            str(index): name for index, name in normalized.items()
        }
    else:
        entry_config.pop("column_names", None)

    if entry_config.get("enabled", True):
        entry_config.pop("enabled", None)
    if not entry_config.get("disabled_columns"):
        entry_config.pop("disabled_columns", None)

    if entry_config:
        arrays_config[array_id] = entry_config
    else:
        arrays_config.pop(array_id, None)

    storage.save_visibility_config(safe_project_name, {"arrays": arrays_config})
    storage.ensure_project_manifest(safe_project_name, arrays)
    return normalized


def array_column_names(
    project_name: str,
    array_id: str,
    *,
    storage=project_storage,
) -> Dict[int, str]:
    """Gets custom column names for array."""

    manifest = storage.ensure_project_manifest(project_name)
    entry = storage.find_array_entry_by_id(manifest, array_id)
    if entry is None:
        return {}

    config = storage.load_visibility_config(project_name)
    arrays_config = config.get("arrays", {}) if isinstance(config, dict) else {}
    entry_config = arrays_config.get(array_id, {}) if isinstance(arrays_config, dict) else {}
    names = entry_config.get("column_names") if isinstance(entry_config, dict) else None
    return normalize_column_name_map(names)


def _normalize_disabled_columns(values) -> list:
    """Normalize disabled column indices into a sorted list."""

    if values is None:
        return []

    if not isinstance(values, (list, tuple, set)):
        return []

    normalized = []
    for item in values:
        try:
            number = int(item)
        except (TypeError, ValueError):
            continue
        if number < 0:
            continue
        normalized.append(number)

    return sorted(set(normalized))


__all__ = [
    "array_column_names",
    "project_visibility",
    "update_array_column_names",
    "update_project_visibility",
]


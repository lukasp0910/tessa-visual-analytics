"""Helpers for storing and retrieving array visibility settings."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Tuple

from ._utils import _now_iso
from .manifest import (
    _legacy_flat_visibility_file_path,
    _legacy_visibility_file_path,
    ensure_project_manifest,
    load_project_manifest,
    project_info_path,
    save_project_manifest,
)


def load_visibility_config(file_name: str) -> Dict[str, Any]:
    manifest = ensure_project_manifest(file_name)
    visibility = manifest.get("visibility")
    arrays = visibility.get("arrays") if isinstance(visibility, dict) else None
    if not isinstance(arrays, dict):
        arrays = {}
    return {"arrays": arrays}


def save_visibility_config(file_name: str, config: Dict[str, Any]) -> Path:
    manifest = ensure_project_manifest(file_name)
    arrays_section = manifest.get("arrays", [])
    valid_ids = {entry.get("id") for entry in arrays_section if isinstance(entry, dict)}

    arrays = config.get("arrays") if isinstance(config, dict) else None
    if not isinstance(arrays, dict):
        arrays = {}

    sanitized: Dict[str, Dict[str, Any]] = {}
    for array_id, entry in arrays.items():
        if array_id not in valid_ids or not isinstance(entry, dict):
            continue
        enabled = bool(entry.get("enabled", True))
        columns = _normalize_disabled_columns(entry.get("disabled_columns"))
        column_names = _normalize_column_names(entry.get("column_names"))

        record: Dict[str, Any] = {}
        if not enabled:
            record["enabled"] = False
        if columns:
            record["disabled_columns"] = columns
        if column_names:
            record["column_names"] = column_names

        if record:
            sanitized[array_id] = record

    manifest.setdefault("visibility", {})["arrays"] = sanitized
    manifest.setdefault("project", {}).setdefault("created_at", _now_iso())
    manifest["project"]["updated_at"] = _now_iso()

    return save_project_manifest(file_name, manifest)


def delete_visibility_config(file_name: str) -> bool:
    safe_name = Path(file_name).name
    path = project_info_path(safe_name)
    removed = False

    if path.exists():
        manifest = load_project_manifest(safe_name)
        visibility = manifest.get("visibility")
        if isinstance(visibility, dict) and visibility.get("arrays"):
            visibility["arrays"] = {}
            manifest.setdefault("project", {}).setdefault("created_at", _now_iso())
            manifest["project"]["updated_at"] = _now_iso()
            save_project_manifest(safe_name, manifest)
            removed = True

    for candidate in (
        _legacy_visibility_file_path(safe_name),
        _legacy_flat_visibility_file_path(safe_name),
    ):
        if candidate.exists():
            candidate.unlink()
            removed = True

    return removed


def _normalize_disabled_columns(values) -> List[int]:
    """Normalize a collection of disabled column indices."""

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


def _normalize_column_names(values) -> Dict[str, str]:
    """Normalize stored column name overrides into a string-keyed mapping."""

    if values is None:
        return {}

    items: List[Tuple[int, object]] = []

    if isinstance(values, str):
        items = list(enumerate(values.split(","), start=1))
    elif isinstance(values, dict):
        items = [(key, val) for key, val in values.items()]
    elif isinstance(values, (list, tuple)):
        items = list(enumerate(values, start=1))
    else:
        return {}

    normalized: Dict[int, str] = {}
    for raw_index, raw_value in items:
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            continue
        if index < 1:
            continue
        text = str(raw_value).strip()
        if not text:
            continue
        normalized[index] = text

    return {str(index): name for index, name in sorted(normalized.items())}

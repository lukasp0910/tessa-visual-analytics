"""Helpers for managing and inferring project time axis information."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Tuple

import numpy as np

from app.storage import project_storage

ArrayMap = Mapping[str, np.ndarray]


def _array_row_count(array: np.ndarray) -> int:
    """Counts rows in array."""

    if array.ndim == 0:
        return 1
    return int(array.shape[0]) if array.shape else 0


def _build_manifest_lookup(manifest: MutableMapping[str, Any]) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """Builds lookup dicts by ID and name."""

    entries = manifest.get("arrays") if isinstance(manifest, MutableMapping) else None
    if not isinstance(entries, Iterable):
        return {}, {}

    by_name: Dict[str, Dict[str, Any]] = {}
    by_id: Dict[str, Dict[str, Any]] = {}

    for entry in entries:  # type: ignore[assignment]
        if not isinstance(entry, MutableMapping):
            continue
        entry_id = str(entry.get("id") or "").strip() or None
        entry_name = str(entry.get("name") or "").strip() or None
        if entry_name:
            by_name[entry_name] = entry
        if entry_id:
            by_id[entry_id] = entry

    return by_name, by_id


def _resolve_entry(
    selection: Mapping[str, Any],
    *,
    by_name: Mapping[str, Mapping[str, Any]],
    by_id: Mapping[str, Mapping[str, Any]],
) -> Optional[Mapping[str, Any]]:
    """Finds manifest entry from selection."""

    array_id = str(selection.get("array_id") or "").strip() or None
    array_name = str(selection.get("array_name") or "").strip() or None

    if array_id and array_id in by_id:
        return by_id[array_id]
    if array_name and array_name in by_name:
        return by_name[array_name]
    return None


def _sanitize_time_axis(selection: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    if selection is None:
        return None
    if not isinstance(selection, Mapping):
        return None

    normalized: Dict[str, Any] = {}

    array_id = str(selection.get("array_id") or "").strip() or None
    array_name = str(selection.get("array_name") or "").strip() or None
    if array_id:
        normalized["array_id"] = array_id
    if array_name:
        normalized["array_name"] = array_name

    source = selection.get("source")
    if source is not None:
        text = str(source).strip().lower()
        if text:
            normalized["source"] = text

    return normalized or None


def detect_time_axis(
    arrays: ArrayMap,
    manifest: MutableMapping[str, Any],
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    """Auto-detects time axis and returns any issues."""

    if not arrays:
        return None, []

    by_name, _ = _build_manifest_lookup(manifest)
    entries = manifest.get("arrays") if isinstance(manifest, MutableMapping) else None
    ordered_names: List[str] = []
    seen: set[str] = set()

    if isinstance(entries, Iterable):
        for entry in entries:  # type: ignore[assignment]
            if not isinstance(entry, MutableMapping):
                continue
            name = str(entry.get("name") or "").strip()
            if not name or name in seen or name not in arrays:
                continue
            ordered_names.append(name)
            seen.add(name)

    for name in arrays.keys():
        if name in seen:
            continue
        ordered_names.append(name)
        seen.add(name)

    if not ordered_names:
        return None, []

    issues: List[Dict[str, Any]] = []
    baseline: Optional[int] = None

    for name in ordered_names:
        array = arrays.get(name)
        if array is None:
            continue
        row_count = _array_row_count(array)
        if baseline is None:
            baseline = row_count
            continue
        if row_count != baseline:
            issue = {
                "array_name": name,
                "row_count": row_count,
                "expected_row_count": baseline,
            }
            entry = by_name.get(name)
            if entry and entry.get("id"):
                issue["array_id"] = entry["id"]
            issues.append(issue)

    if baseline is None:
        return None, []

    if issues:
        return None, issues

    selected_name = ordered_names[0]
    entry = by_name.get(selected_name)

    selection = {
        "array_name": selected_name,
        "source": "auto",
    }
    if entry and entry.get("id"):
        selection["array_id"] = entry["id"]

    return selection, []


def _enrich_selection(
    selection: Optional[Mapping[str, Any]],
    arrays: ArrayMap,
    manifest: MutableMapping[str, Any],
) -> Optional[Dict[str, Any]]:
    """Enriches time axis selection with metadata."""

    sanitized = _sanitize_time_axis(selection)
    if sanitized is None:
        return None

    by_name, by_id = _build_manifest_lookup(manifest)
    entry = _resolve_entry(sanitized, by_name=by_name, by_id=by_id)

    if entry is None:
        return None

    enriched = dict(sanitized)
    enriched["array_id"] = entry.get("id")
    enriched["array_name"] = entry.get("name")

    source = str(enriched.get("source") or "").strip().lower()
    if not source:
        enriched["source"] = "manual"

    return enriched


def resolve_time_axis(
    project_name: str,
    arrays: ArrayMap,
    *,
    manifest: Optional[MutableMapping[str, Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    """Gets stored time axis, updates if needed."""

    manifest = manifest or project_storage.ensure_project_manifest(project_name, arrays)

    stored = project_storage.time_axis_from_manifest(manifest)
    enriched_stored = _enrich_selection(stored, arrays, manifest)

    if enriched_stored != stored:
        project_storage.save_time_axis(project_name, enriched_stored, arrays=arrays)
        manifest = project_storage.ensure_project_manifest(project_name, arrays)
        stored = enriched_stored

    selection, issues = detect_time_axis(arrays, manifest)

    if stored is None and selection is not None and not issues:
        project_storage.save_time_axis(project_name, selection, arrays=arrays)
        stored = selection

    return stored, issues


def update_project_time_axis(
    project_name: str,
    config: Optional[Mapping[str, Any]],
    *,
    arrays: ArrayMap,
) -> Optional[Dict[str, Any]]:
    """Saves manual time axis config."""

    manifest = project_storage.ensure_project_manifest(project_name, arrays)

    if config is None:
        project_storage.save_time_axis(project_name, None, arrays=arrays)
        return None

    by_name, by_id = _build_manifest_lookup(manifest)
    selection = _sanitize_time_axis(config)

    if selection is None:
        project_storage.save_time_axis(project_name, None, arrays=arrays)
        return None

    entry = _resolve_entry(selection, by_name=by_name, by_id=by_id)
    if entry is None:
        raise ValueError("Referenced array for time axis could not be found")

    array_name = entry.get("name")
    if array_name is None or array_name not in arrays:
        raise ValueError("Referenced array for time axis could not be found")

    enriched = dict(selection)
    enriched["array_id"] = entry.get("id")
    enriched["array_name"] = array_name

    source = str(enriched.get("source") or "").strip().lower() or "manual"
    if source not in {"auto", "manual", "unknown"}:
        raise ValueError("source must be one of 'auto', 'manual', or 'unknown'")
    if source == "auto":
        # Manual updates never get auto flag
        source = "manual"
    enriched["source"] = source

    project_storage.save_time_axis(project_name, enriched, arrays=arrays)
    return enriched


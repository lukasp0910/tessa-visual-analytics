"""Subject handling utilities for multi-subject experimental data."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

import numpy as np

from app.services.registry import get_project, load_project_from_disk
from app.storage import project_storage

MAX_UNIQUE_VALUES = 512
DISPLAY_VALUE_LIMIT = 12
SUBJECT_NAME_LIMIT = 1024


@dataclass
class ArraySubjectSummary:
    array_id: str
    array_name: str
    row_count: int
    sample_size: int
    value_count: int
    values: List[str]
    values_truncated: bool
    sample_limited: bool


@dataclass
class SubjectGroup:
    key: str
    subject_count: int
    values: List[str]
    values_truncated: bool
    sample_limited: bool
    arrays: List[ArraySubjectSummary]


def _to_python_value(value: Any) -> Any:
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, (bytes, bytearray)):
        try:
            return value.decode("utf-8", errors="replace")
        except Exception:  # pragma: no cover - defensive
            return value.decode("latin-1", errors="replace")
    if isinstance(value, np.datetime64):
        try:
            return np.datetime_as_string(value, unit="auto")
        except ValueError:  # pragma: no cover - fallback
            return str(value)
    if isinstance(value, (np.timedelta64,)):
        return str(value)
    return value


def _format_value(value: Any) -> str:
    value = _to_python_value(value)
    if value is None:
        return "∅"
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "∞" if value > 0 else "-∞"
        formatted = f"{value:.6g}"
        if formatted == "-0":
            return "0"
        return formatted
    if isinstance(value, bool):
        return "True" if value else "False"
    return str(value)


def _canonical_value(value: Any) -> Tuple[str, str]:
    value = _to_python_value(value)
    if value is None:
        return ("none", "")
    if isinstance(value, bool):
        return ("bool", "true" if value else "false")
    if isinstance(value, float):
        if math.isnan(value):
            return ("nan", "")
        if math.isinf(value):
            return ("inf", "inf" if value > 0 else "-inf")
        return ("number", _format_value(value))
    if isinstance(value, (int, np.integer)):
        return ("number", _format_value(value))
    if isinstance(value, (str, np.str_)):
        return ("str", value)
    if isinstance(value, (bytes, bytearray, np.bytes_)):
        text = _format_value(value)
        return ("bytes", text)
    return (value.__class__.__name__.lower(), _format_value(value))


def normalize_subject_array_ids(
    array_ids: Optional[Iterable[Any]],
    manifest: Optional[Mapping[str, Any]] = None,
) -> List[str]:
    if array_ids is None:
        candidates: Sequence[Any] = []
    elif isinstance(array_ids, (list, tuple, set)):
        candidates = array_ids
    else:
        candidates = list(array_ids)

    if manifest is None:
        valid_ids: set[str] = set()
    else:
        entries = manifest.get("arrays") if isinstance(manifest, Mapping) else None
        valid_ids = {
            str(entry.get("id"))
            for entry in entries or []
            if isinstance(entry, Mapping) and entry.get("id")
        }

    seen: set[str] = set()
    normalized: List[str] = []
    for raw in candidates:
        if raw is None:
            continue
        text = str(raw).strip()
        if not text:
            continue
        if valid_ids and text not in valid_ids:
            continue
        if text in seen:
            continue
        seen.add(text)
        normalized.append(text)
    return normalized


def normalize_subject_name_map(
    values: Optional[Mapping[str, Any] | Iterable[Tuple[Any, Any]]]
) -> Dict[str, str]:
    if values is None:
        return {}

    if isinstance(values, Mapping):
        items = values.items()
    else:
        try:
            items = dict(values or {}).items()  # type: ignore[arg-type]
        except Exception:  # pragma: no cover - defensive guard
            return {}

    normalized: Dict[str, str] = {}
    for raw_key, raw_value in items:
        key = str(raw_key or "").strip()
        if not key:
            continue
        text = str(raw_value or "").strip()
        if not text:
            continue
        normalized[key] = text
        if len(normalized) >= SUBJECT_NAME_LIMIT:
            break

    return normalized


def _sample_first_column(array: np.ndarray) -> Tuple[np.ndarray, int, bool]:
    if array.ndim == 0:
        reshaped = array.reshape(1, 1)
    else:
        row_count = int(array.shape[0]) if array.ndim >= 1 else 1
        if row_count < 0:
            row_count = 0
        try:
            reshaped = array.reshape(row_count, -1)
        except ValueError:
            reshaped = array.reshape(-1, 1)
    if reshaped.size == 0:
        return np.array([], dtype=array.dtype), 0, False
    column = reshaped[:, 0]
    total_rows = column.shape[0]
    return column, total_rows, False


def _unique_values(column: np.ndarray) -> Tuple[np.ndarray, bool]:
    if column.size == 0:
        return np.array([], dtype=column.dtype), False
    try:
        unique = np.unique(column)
    except TypeError:
        # Use str for unhashable types
        unique = np.unique(column.astype("U"))
    if unique.size <= MAX_UNIQUE_VALUES:
        return unique, False
    return unique[:MAX_UNIQUE_VALUES], True


def analyze_subject_groups(project_name: str) -> Dict[str, Any]:
    project = get_project(project_name)
    if project is None:
        if not load_project_from_disk(project_name):
            raise FileNotFoundError(f"Project {project_name!r} not found")
        project = get_project(project_name)
        if project is None:
            raise FileNotFoundError(f"Project {project_name!r} not found")

    manifest = project_storage.ensure_project_manifest(project_name, project)
    project_section = manifest.get("project") if isinstance(manifest, dict) else None
    stored_array_ids = normalize_subject_array_ids(
        project_section.get("subject_arrays") if isinstance(project_section, Mapping) else None,
        manifest,
    )

    stored_names: Dict[str, str] = {}
    if isinstance(project_section, Mapping):
        stored_names = normalize_subject_name_map(project_section.get("subject_names"))

    array_entries = manifest.get("arrays") if isinstance(manifest, Mapping) else None
    name_lookup: Dict[str, Mapping[str, Any]] = {}
    if isinstance(array_entries, list):
        for entry in array_entries:
            if not isinstance(entry, Mapping):
                continue
            entry_name = str(entry.get("name") or "").strip()
            if entry_name:
                name_lookup[entry_name] = entry

    group_map: MutableMapping[Tuple[Tuple[str, str], ...], SubjectGroup] = {}

    for array_name, array in project.items():
        entry = name_lookup.get(array_name)
        if entry is None:
            continue
        array_id = str(entry.get("id") or "").strip()
        if not array_id:
            continue

        column, total_rows, sample_limited = _sample_first_column(array)
        unique_values, values_limited = _unique_values(column)
        subject_count = int(unique_values.size)

        canonical_values = tuple(_canonical_value(value) for value in unique_values)
        group_key = canonical_values
        values_display = [_format_value(value) for value in unique_values[:DISPLAY_VALUE_LIMIT]]
        values_truncated = subject_count > DISPLAY_VALUE_LIMIT or values_limited

        summary = ArraySubjectSummary(
            array_id=array_id,
            array_name=array_name,
            row_count=int(total_rows),
            sample_size=int(column.shape[0]),
            value_count=subject_count,
            values=values_display,
            values_truncated=values_truncated,
            sample_limited=sample_limited,
        )

        group = group_map.get(group_key)
        if group is None:
            group = SubjectGroup(
                key="::".join(f"{kind}:{value}" for kind, value in canonical_values),
                subject_count=subject_count,
                values=values_display,
                values_truncated=values_truncated,
                sample_limited=sample_limited,
                arrays=[summary],
            )
            group_map[group_key] = group
        else:
            group.arrays.append(summary)
            group.subject_count = max(group.subject_count, subject_count)
            group.values_truncated = group.values_truncated or values_truncated
            group.sample_limited = group.sample_limited or sample_limited
            if not group.values and values_display:
                group.values = values_display

    groups = list(group_map.values())
    groups.sort(
        key=lambda item: (
            item.subject_count,
            -len(item.arrays),
            item.key,
        )
    )
    for group in groups:
        group.arrays.sort(
            key=lambda entry: (
                entry.value_count if entry.value_count is not None else math.inf,
                entry.array_name.lower(),
            )
        )

    return {
        "project": project_name,
        "groups": [
            {
                "id": group.key or "default",
                "subject_count": group.subject_count,
                "values": group.values,
                "values_truncated": group.values_truncated,
                "sample_limited": group.sample_limited,
                "arrays": [
                    {
                        "array_id": summary.array_id,
                        "array_name": summary.array_name,
                        "row_count": summary.row_count,
                        "sample_size": summary.sample_size,
                        "value_count": summary.value_count,
                        "values": summary.values,
                        "values_truncated": summary.values_truncated,
                        "sample_limited": summary.sample_limited,
                    }
                    for summary in group.arrays
                ],
            }
            for group in groups
        ],
        "selected_array_ids": stored_array_ids,
        "subject_names": stored_names,
    }


__all__ = [
    "analyze_subject_groups",
    "normalize_subject_array_ids",
    "normalize_subject_name_map",
]

"""Line chart data preparation and formatting utilities."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
import math
import re
from typing import Dict, Iterable, List, Mapping, Sequence, Tuple

import numpy as np

from app.services import metadata, registry, visibility
from app.storage import project_storage


class LineChartError(Exception):
    """Base exception for line chart stuff."""


class InvalidDatasetError(LineChartError):
    """Bad dataset identifier."""


class DatasetNotFoundError(LineChartError):
    """Dataset not found in project."""


class ColumnNotFoundError(LineChartError):
    """Column doesn't exist."""


class EmptyDatasetError(LineChartError):
    """Dataset has no rows."""


@dataclass
class LineChartData:
    """Holds timestamps and values for chart rendering."""

    timestamps: List[object]
    values: List[object]
    series: List["LineChartSeries"]


@dataclass
class LineChartSeries:
    """Single column data for plotting."""

    key: str
    label: str
    column_index: int
    values: List[object]


_DATASET_DELIMITER = "::"
_COLUMN_PATTERN = re.compile(r"^column\s+(?P<index>\d+)$", re.IGNORECASE)


def get_linechart_data(
    dataset_id: str,
    time_column: str | None,
    measure_column: str | Sequence[str],
    subject_id: str | None = None,
) -> LineChartData:
    """Extract line chart data from a project array.

    Args:
        dataset_id: Identifier in format "<project>::<array>" where <array>
            is the manifest identifier or array name
        time_column: Deprecated parameter, row index is used instead
        measure_column: Label or index of the column(s) to plot
        subject_id: Filter rows by subject ID for multi-subject arrays
    
    Returns:
        LineChartData containing timestamps, values, and series metadata
    """

    project_name, array_entry = _resolve_dataset(dataset_id)
    array = array_entry["array"]
    array_id = array_entry["id"]

    manifest = project_storage.ensure_project_manifest(project_name)
    project_info = manifest.get("project") if isinstance(manifest, Mapping) else {}

    subject_names = _normalize_subject_name_map(project_info.get("subject_names"))
    subject_mode = _normalize_subject_mode_value(project_info.get("subject_mode"))
    subject_arrays = _normalize_subject_array_ids(project_info.get("subject_arrays"))

    normalized_subject = _normalize_subject_value(subject_id)
    if normalized_subject and normalized_subject.upper() == "ALL":
        normalized_subject = None

    subject_name = (
        subject_names.get(normalized_subject, normalized_subject)
        if normalized_subject
        else None
    )

    is_multi_subject_array = (
        subject_mode == "multi"
        and str(array_id) in subject_arrays
    )

    if array.ndim == 0:
        row_count = 1
    else:
        row_count = int(array.shape[0]) if array.shape else 0

    if row_count <= 0:
        raise EmptyDatasetError("Dataset does not contain any rows")

    reshaped = array.reshape(row_count, -1)
    column_count = int(reshaped.shape[1]) if reshaped.ndim == 2 else 1

    # Filter by subject if specified
    if normalized_subject and column_count >= 1:
        col0 = reshaped[:, 0]
        mask = None
        target_text = str(normalized_subject).strip()
        
        try:
            if np.issubdtype(col0.dtype, np.number):
                target_num = float(target_text)
                if np.issubdtype(col0.dtype, np.integer):
                    target_val = int(round(target_num))
                else:
                    target_val = target_num
                mask = (col0 == target_val)
            else:
                mask = (col0.astype("U") == target_text)
        except Exception:
            mask = (col0.astype("U") == target_text)

        if mask is not None:
            reshaped = reshaped[mask]
            row_count = int(reshaped.shape[0]) if reshaped.ndim == 2 else int(reshaped.size > 0)

        if row_count <= 0:
            raise EmptyDatasetError("No rows available for the selected subject")

    default_columns = [f"Column {index + 1}" for index in range(column_count)] or ["Value"]
    custom_names = visibility.array_column_names(project_name, array_id)
    resolved_columns = metadata.apply_column_names(default_columns, custom_names)

    measure_columns = _normalize_measure_columns(measure_column)
    if not measure_columns:
        raise ColumnNotFoundError("At least one measure column must be provided")

    # Multi-subject without filter: one series per subject
    if is_multi_subject_array and not normalized_subject and column_count >= 1:
        return _build_multi_subject_series(
            reshaped, measure_columns, resolved_columns, subject_names
        )

    # Timestamps: 1..N
    timestamps = [index + 1 for index in range(int(reshaped.shape[0]) if reshaped.ndim == 2 else row_count)]
    series: List[LineChartSeries] = []
    seen_indices: set[int] = set()

    for identifier in measure_columns:
        measure_index = _resolve_column_index(identifier, resolved_columns)
        if measure_index >= (int(reshaped.shape[1]) if reshaped.ndim == 2 else 1):
            raise ColumnNotFoundError("Requested column is out of range")
        if measure_index in seen_indices:
            continue

        values_column = reshaped[:, measure_index]
        values = [_normalize_value(item) for item in values_column]

        label = str(resolved_columns[measure_index] or "").strip()
        if not label:
            label = f"Column {measure_index + 1}"

        # Add subject to label if selected
        if subject_name:
            label = f"{label} ({subject_name})"

        series.append(
            LineChartSeries(
                key=f"column_{measure_index + 1}",
                label=label,
                column_index=measure_index + 1,
                values=values,
            )
        )
        seen_indices.add(measure_index)

    primary_values = series[0].values if series else []

    return LineChartData(timestamps=timestamps, values=primary_values, series=series)


def _resolve_dataset(dataset_id: str) -> Tuple[str, Mapping[str, object]]:
    """Gets project name and manifest entry for dataset."""

    if not isinstance(dataset_id, str):
        raise InvalidDatasetError("Dataset identifier must be a string")

    normalized = dataset_id.strip()
    if not normalized:
        raise InvalidDatasetError("Dataset identifier cannot be empty")

    if _DATASET_DELIMITER not in normalized:
        raise InvalidDatasetError(
            "Dataset identifier must include a project and array reference"
        )

    project_name, array_selector = normalized.split(_DATASET_DELIMITER, 1)
    project_name = project_name.strip()
    array_selector = array_selector.strip()

    if not project_name or not array_selector:
        raise InvalidDatasetError(
            "Dataset identifier must include both project and array components"
        )

    arrays = registry.get_project(project_name)
    if arrays is None and not registry.load_project_from_disk(project_name):
        raise DatasetNotFoundError("Project could not be loaded")

    arrays = registry.get_project(project_name)
    if arrays is None:
        raise DatasetNotFoundError("Project is not available")

    manifest = project_storage.ensure_project_manifest(project_name, arrays)
    entry = project_storage.find_array_entry_by_id(manifest, array_selector)
    if entry is None:
        entry = project_storage.find_array_entry_by_name(manifest, array_selector)

    if entry is None:
        raise DatasetNotFoundError("Array not found in project")

    array_name = entry.get("name") or ""
    if array_name not in arrays:
        raise DatasetNotFoundError("Array data could not be located")

    payload = dict(entry)
    payload["array"] = arrays[array_name]
    payload["id"] = entry.get("id") or array_selector

    return project_name, payload


def _resolve_column_index(column: str, columns: Sequence[str]) -> int:
    """Finds column index from label or number."""

    if not isinstance(column, str):
        raise ColumnNotFoundError("Column identifier must be a string")

    normalized = column.strip()
    if not normalized:
        raise ColumnNotFoundError("Column identifier cannot be empty")

    index = _parse_column_index(normalized)
    if index is not None:
        return index

    normalized_lower = normalized.lower()
    for candidate_index, label in enumerate(columns):
        label_text = str(label or "").strip()
        if not label_text:
            continue
        if normalized_lower == label_text.lower():
            return candidate_index

    raise ColumnNotFoundError(f"Column {column!r} not found")


def _normalize_measure_columns(columns: str | Sequence[str]) -> List[str]:
    """Normalizes column list for plotting."""

    if isinstance(columns, str):
        normalized = columns.strip()
        return [normalized] if normalized else []

    if isinstance(columns, Iterable):
        normalized_columns: List[str] = []
        for entry in columns:
            if not isinstance(entry, str):
                continue
            normalized = entry.strip()
            if not normalized:
                continue
            normalized_columns.append(normalized)
        return normalized_columns

    return []


def _parse_column_index(identifier: str) -> int | None:
    """Parse a column index from the provided identifier if possible."""

    try:
        value = int(identifier)
    except (TypeError, ValueError):
        match = _COLUMN_PATTERN.match(identifier)
        if match:
            value = int(match.group("index"))
        else:
            return None

    if value < 1:
        raise ColumnNotFoundError("Column index must be positive")
    return value - 1


def _normalize_value(value: object) -> object:
    """Convert numpy scalars into JSON-serializable Python values."""

    if isinstance(value, np.generic):
        value = value.item()

    if isinstance(value, np.datetime64):
        return np.datetime_as_string(value, unit="auto")

    if isinstance(value, (datetime, date)):
        return value.isoformat()

    if isinstance(value, Decimal):
        value = float(value)

    if isinstance(value, (float, np.floating)):
        if not math.isfinite(float(value)):
            return None
        return float(value)

    if isinstance(value, (np.integer, int)):
        return int(value)

    if isinstance(value, (np.bool_, bool)):
        return bool(value)

    return value


def _normalize_subject_value(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, (np.bool_, bool)):
        return "True" if bool(value) else "False"
    if isinstance(value, (np.integer, int)):
        return str(int(value))
    if isinstance(value, (np.floating, float)):
        numeric = float(value)
        if math.isfinite(numeric) and numeric.is_integer():
            return str(int(numeric))

    try:
        text = str(value).strip()
    except Exception:
        return None
    return text or None


def _normalize_subject_mode_value(value: object) -> str:
    if isinstance(value, str):
        cleaned = value.strip().lower()
        if cleaned in {"multi", "multi-subject"}:
            return "multi"
        if cleaned:
            return "single"
    if isinstance(value, bool):
        return "multi" if value else "single"
    return "single"


def _normalize_subject_array_ids(value: object) -> set[str]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        normalized = {str(entry).strip() for entry in value if str(entry or "").strip()}
        return normalized
    return set()


def _normalize_subject_name_map(value: object) -> Dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    names: Dict[str, str] = {}
    for raw_key, raw_label in value.items():
        key = _normalize_subject_value(raw_key)
        label = _normalize_subject_value(raw_label)
        if not key or not label:
            continue
        names[key] = label
    return names


def _subject_label(raw_subject: object, subject_names: Mapping[str, str]) -> str:
    normalized = _normalize_subject_value(raw_subject)
    if not normalized:
        return ""
    return subject_names.get(normalized, normalized)


def _build_series_key(column_index: int, subject_value: object) -> str:
    subject_text = _normalize_subject_value(subject_value) or "subject"
    safe_subject = re.sub(r"[^a-zA-Z0-9]+", "_", subject_text).strip("_") or "subject"
    return f"subject_{safe_subject}_column_{column_index + 1}"


def _build_multi_subject_series(
    reshaped: np.ndarray,
    measure_columns: str | Sequence[str],
    resolved_columns: Sequence[str],
    subject_names: Mapping[str, str],
) -> LineChartData:
    row_count = int(reshaped.shape[0]) if reshaped.ndim == 2 else int(reshaped.size > 0)
    timestamps = [index + 1 for index in range(int(reshaped.shape[0]) if reshaped.ndim == 2 else row_count)]

    measure_identifiers = _normalize_measure_columns(measure_columns)
    if not measure_identifiers:
        raise ColumnNotFoundError("At least one measure column must be provided")

    subject_column = reshaped[:, 0]
    try:
        unique_subjects = np.unique(subject_column)
    except TypeError:
        unique_subjects = np.unique(subject_column.astype("U"))

    series: List[LineChartSeries] = []

    for subject_value in unique_subjects:
        subject_mask = subject_column == subject_value
        subject_rows = reshaped[subject_mask]
        if subject_rows.size == 0:
            continue

        label_suffix = _subject_label(subject_value, subject_names)
        seen_indices: set[int] = set()

        for identifier in measure_identifiers:
            measure_index = _resolve_column_index(identifier, resolved_columns)
            if measure_index >= (int(subject_rows.shape[1]) if subject_rows.ndim == 2 else 1):
                raise ColumnNotFoundError("Requested column is out of range")
            if measure_index in seen_indices:
                continue

            values_column = subject_rows[:, measure_index]
            values = [_normalize_value(item) for item in values_column]

            label = str(resolved_columns[measure_index] or "").strip()
            if not label:
                label = f"Column {measure_index + 1}"
            if label_suffix:
                label = f"{label} ({label_suffix})"

            series.append(
                LineChartSeries(
                    key=_build_series_key(measure_index, subject_value),
                    label=label,
                    column_index=measure_index + 1,
                    values=values,
                )
            )
            seen_indices.add(measure_index)

    primary_values = series[0].values if series else []
    return LineChartData(timestamps=timestamps, values=primary_values, series=series)


__all__ = [
    "ColumnNotFoundError",
    "DatasetNotFoundError",
    "EmptyDatasetError",
    "InvalidDatasetError",
    "LineChartData",
    "LineChartSeries",
    "get_linechart_data",
]

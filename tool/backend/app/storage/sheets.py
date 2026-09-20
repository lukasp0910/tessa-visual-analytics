"""Helpers for storing dashboard sheet configurations."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

from ._utils import _SHEETS_FILENAME, _load_manifest, _now_iso
from .paths import project_directory


_SHEET_NAME_PATTERN = re.compile(r"^Sheet\s*(\d+)$", re.IGNORECASE)
_SHEET_ID_PATTERN = re.compile(r"^sheet-(\d+)$", re.IGNORECASE)

_DEFAULT_ROW_COUNT = 12
_DEFAULT_COLUMN_COUNT = 12


def _sanitize_dimension(value: Any, *, default: int) -> int:
    """Cleans up grid dimension value."""

    if value is None:
        return default
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value if value >= 1 else default
    if isinstance(value, float):
        if not value.is_integer() or value < 1:
            return default
        return int(value)
    try:
        text = str(value).strip()
    except Exception:
        return default
    if not text:
        return default
    try:
        number = int(text)
    except (TypeError, ValueError):
        return default
    if number < 1:
        return default
    return number


def _sanitize_card_coordinate(value: Any, *, limit: int) -> int:
    """Clamp a card coordinate to the inclusive [0, limit] range."""

    if isinstance(value, bool) or value is None:
        candidate = 0
    elif isinstance(value, int):
        candidate = value
    elif isinstance(value, float):
        candidate = int(value) if value.is_integer() else 0
    else:
        try:
            text = str(value).strip()
        except Exception:
            text = ""
        if not text:
            candidate = 0
        else:
            try:
                candidate = int(text)
            except (TypeError, ValueError):
                candidate = 0

    if candidate < 0:
        return 0
    if candidate > limit:
        return limit
    return candidate


def _sanitize_card_point(value: Any, *, max_row: int, max_column: int) -> Tuple[int, int]:
    """Normalize a card corner description."""

    if isinstance(value, dict):
        row_value = value.get("row")
        column_value = value.get("column")
    else:
        row_value = None
        column_value = None

    row = _sanitize_card_coordinate(row_value, limit=max_row)
    column = _sanitize_card_coordinate(column_value, limit=max_column)
    return row, column


def _sanitize_string(value: Any) -> str | None:
    """Converts to string if possible."""

    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        text = str(value).strip()
    except Exception:
        return None
    return text or None


def _coerce_json_like(value: Any) -> Any:
    """Best effort conversion of arbitrary values to JSON-like structures."""

    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int,)):  # bool already handled
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if isinstance(value, list):
        normalized = []
        for item in value:
            coerced = _coerce_json_like(item)
            if coerced is not None:
                normalized.append(coerced)
        return normalized
    if isinstance(value, dict):
        result: Dict[str, Any] = {}
        for key, raw in value.items():
            key_text = _sanitize_string(key)
            if not key_text:
                continue
            coerced = _coerce_json_like(raw)
            if coerced is not None:
                result[key_text] = coerced
        return result
    text = _sanitize_string(value)
    return text


def _sanitize_boolean(value: Any) -> bool | None:
    """Tries to parse boolean value."""

    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in {0, 1}:
        return bool(value)
    if isinstance(value, float) and value in {0.0, 1.0}:
        return bool(int(value))
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"true", "1", "yes", "y", "on"}:
            return True
        if text in {"false", "0", "no", "n", "off"}:
            return False
    return None


def _sanitize_line_measure(value: Any) -> Dict[str, Any] | None:
    """Normalize a single line chart measure entry."""

    if not isinstance(value, dict):
        return None

    identifier = _sanitize_string(value.get("id"))
    source = _sanitize_string(
        value.get("source") or value.get("sourceId") or value.get("source_id")
    )
    column = _sanitize_string(
        value.get("column") or value.get("columnId") or value.get("column_id")
    )
    subject = _sanitize_string(
        value.get("subject")
        or value.get("subjectId")
        or value.get("subject_id")
    )
    source_label = _sanitize_string(
        value.get("sourceLabel") or value.get("source_label")
    )
    column_label = _sanitize_string(
        value.get("columnLabel") or value.get("column_label")
    )

    multi_subject = None
    for key in ("multiSubject", "multi_subject", "requiresSubject", "subjectRequired"):
        if key in value:
            multi_subject = _sanitize_boolean(value.get(key))
            if multi_subject is not None:
                break

    measure: Dict[str, Any] = {}
    if identifier:
        measure["id"] = identifier
    if source:
        measure["source"] = source
    if column:
        measure["column"] = column
    if subject:
        measure["subject"] = subject
    if source_label:
        measure["sourceLabel"] = source_label
    if column_label:
        measure["columnLabel"] = column_label
    if multi_subject is not None:
        measure["multiSubject"] = multi_subject

    return measure or None


def _sanitize_field_values(value: Any, *, chart_type: str) -> Dict[str, Any]:
    """Normalize the stored field value configuration for a card."""

    if not isinstance(value, dict):
        return {}

    sanitized: Dict[str, Any] = {}
    # Common fields across chart types
    title_value = _sanitize_string(value.get("title"))
    if title_value:
        sanitized["title"] = title_value

    if chart_type == "line":
        measures_value = value.get("measures")
        if isinstance(measures_value, list):
            measures: List[Dict[str, Any]] = []
            for entry in measures_value:
                measure = _sanitize_line_measure(entry)
                if measure:
                    measures.append(measure)
            if measures:
                sanitized["measures"] = measures

        axis_value = _sanitize_string(value.get("x"))
        if axis_value:
            sanitized["x"] = axis_value

    elif chart_type == "scatter":
        raw_columns = value.get("columns")
        if isinstance(raw_columns, list):
            columns: List[str] = []
            for entry in raw_columns:
                if isinstance(entry, dict):
                    column_id = _sanitize_string(entry.get("id")) or _sanitize_string(
                        entry.get("column")
                    )
                else:
                    column_id = _sanitize_string(entry)
                if column_id:
                    columns.append(column_id)
            if columns:
                sanitized["columns"] = columns

        raw_dimension = value.get("dimension")
        dimension = None
        if isinstance(raw_dimension, (int, float)):
            candidate = int(raw_dimension)
            if candidate in {2, 3}:
                dimension = candidate
        elif isinstance(raw_dimension, str):
            text = raw_dimension.strip()
            if text:
                try:
                    candidate = int(text)
                except (TypeError, ValueError):
                    candidate = None
                else:
                    if candidate in {2, 3}:
                        dimension = candidate
        if dimension in {2, 3}:
            sanitized["dimension"] = dimension

        reduction_value = _sanitize_string(value.get("reduction"))
        if reduction_value:
            normalized_reduction = reduction_value.lower()
            if normalized_reduction in {"pca", "tsne", "umap"}:
                sanitized["reduction"] = normalized_reduction

        subject_value = _sanitize_string(value.get("subject"))
        if subject_value:
            sanitized["subject"] = subject_value

        multi_subject_value = _sanitize_boolean(
            value.get("multiSubject") or value.get("multi_subject")
        )
        if multi_subject_value is not None:
            sanitized["multiSubject"] = multi_subject_value

        subject_label_value = _sanitize_string(
            value.get("subjectLabel") or value.get("subject_label")
        )
        if subject_label_value:
            sanitized["subjectLabel"] = subject_label_value

        column_labels_value = value.get("columnLabels") or value.get("column_labels")
        if isinstance(column_labels_value, list):
            column_labels: List[str] = []
            for entry in column_labels_value:
                label = _sanitize_string(entry)
                if label:
                    column_labels.append(label)
            if column_labels:
                sanitized["columnLabels"] = column_labels

    for key, raw in value.items():
        if chart_type == "line" and key in {"measures", "x"}:
            continue
        if chart_type == "scatter":
            continue
        key_text = _sanitize_string(key)
        if not key_text:
            continue
        coerced = _coerce_json_like(raw)
        if coerced is None:
            continue
        if isinstance(coerced, (list, dict)) and not coerced:
            continue
        sanitized[key_text] = coerced

    return sanitized


def _sanitize_card_configuration(value: Any) -> Dict[str, Any] | None:
    """Normalize a persisted card configuration payload."""

    if not isinstance(value, dict):
        return None

    chart_type = _sanitize_string(value.get("chartType") or value.get("chart_type"))
    chart_type_label = _sanitize_string(
        value.get("chartTypeLabel") or value.get("chart_type_label")
    )
    data_source_id = _sanitize_string(
        value.get("dataSourceId") or value.get("data_source_id")
    )
    data_source_label = _sanitize_string(
        value.get("dataSourceLabel") or value.get("data_source_label")
    )
    raw_field_values = value.get("fieldValues") or value.get("field_values")
    field_values = _sanitize_field_values(raw_field_values, chart_type=chart_type or "")

    configuration: Dict[str, Any] = {}
    if chart_type:
        configuration["chartType"] = chart_type
    if chart_type_label:
        configuration["chartTypeLabel"] = chart_type_label
    if data_source_id:
        configuration["dataSourceId"] = data_source_id
    if data_source_label:
        configuration["dataSourceLabel"] = data_source_label
    if field_values:
        configuration["fieldValues"] = field_values

    return configuration or None


def _sanitize_cards(
    value: Any,
    *,
    row_count: int,
    column_count: int,
) -> List[Dict[str, Any]]:
    """Cleans up card list for sheet."""

    if not isinstance(value, list):
        return []

    max_row_index = max(0, row_count - 1)
    max_column_index = max(0, column_count - 1)
    sanitized: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()

    for entry in value:
        if not isinstance(entry, dict):
            continue

        raw_id = entry.get("id")
        card_id = str(raw_id or "").strip()
        if not card_id or card_id in seen_ids:
            continue

        top_left_source = entry.get("topLeft") or entry.get("top_left")
        bottom_right_source = entry.get("bottomRight") or entry.get("bottom_right")

        top_row, left_column = _sanitize_card_point(
            top_left_source,
            max_row=max_row_index,
            max_column=max_column_index,
        )
        bottom_row, right_column = _sanitize_card_point(
            bottom_right_source,
            max_row=max_row_index,
            max_column=max_column_index,
        )

        if bottom_row < top_row:
            bottom_row = top_row
        if right_column < left_column:
            right_column = left_column

        card_entry: Dict[str, Any] = {
            "id": card_id,
            "topLeft": {"row": top_row, "column": left_column},
            "bottomRight": {"row": bottom_row, "column": right_column},
        }
        configuration = entry.get("configuration") or entry.get("config")
        sanitized_config = _sanitize_card_configuration(configuration)
        if sanitized_config:
            card_entry["configuration"] = sanitized_config
        sanitized.append(card_entry)
        seen_ids.add(card_id)

    return sanitized


def _sanitize_last_active_card_id(value: Any) -> str | None:
    """Normalize a stored last active card identifier."""

    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        text = str(value).strip()
    except Exception:
        return None
    return text or None


def _sanitize_last_active_sheet_id(value: Any) -> str | None:
    """Normalize a stored last active sheet identifier."""

    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        text = str(value).strip()
    except Exception:
        return None
    return text or None


def sheet_config_path(file_name: str, *, ensure: bool = False) -> Path:
    """Path to project's sheet config file."""

    safe_name = Path(file_name).name
    directory = project_directory(safe_name, ensure=ensure)
    return directory / _SHEETS_FILENAME


def load_sheet_config(file_name: str) -> Dict[str, Any]:
    """Loads sheet config from disk."""

    safe_name = Path(file_name).name
    path = sheet_config_path(safe_name)
    config = _load_manifest(path)

    if not isinstance(config, dict):
        config = {}

    sheets = config.get("sheets")
    if not isinstance(sheets, list):
        config["sheets"] = []

    return config


def save_sheet_config(file_name: str, config: Dict[str, Any]) -> Path:
    """Writes sheet config to disk."""

    safe_name = Path(file_name).name
    normalized = dict(config) if isinstance(config, dict) else {}

    sheets = normalized.get("sheets")
    if not isinstance(sheets, list):
        sheets = []
    normalized["sheets"] = sheets

    raw_last_active = normalized.get("lastActiveSheetId")
    if raw_last_active is None:
        raw_last_active = normalized.get("last_active_sheet_id")
    last_active = _sanitize_last_active_sheet_id(raw_last_active)
    normalized["lastActiveSheetId"] = last_active
    normalized.pop("last_active_sheet_id", None)

    path = sheet_config_path(safe_name, ensure=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(normalized, handle, indent=2, sort_keys=True)

    return path


def ensure_sheet_config(file_name: str) -> Dict[str, Any]:
    """Ensure that the sheet configuration exists with at least one sheet."""

    safe_name = Path(file_name).name
    config = load_sheet_config(safe_name)

    sheets = config.get("sheets")
    if not isinstance(sheets, list):
        sheets = []

    now = _now_iso()
    sanitized: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()
    max_index = 0
    changed = not isinstance(config.get("sheets"), list)

    for entry in sheets:
        if not isinstance(entry, dict):
            changed = True
            continue

        sheet_id = str(entry.get("id") or "").strip()
        name = str(entry.get("name") or "").strip()

        name_index = _extract_sheet_index(name)
        if not name:
            max_index += 1
            name_index = max_index
            name = _format_sheet_name(name_index)
            changed = True
        elif name_index is not None:
            if name_index > max_index:
                max_index = name_index
        else:
            # Keep custom names separate from index counter
            pass

        if not sheet_id:
            index_for_id = name_index or (len(sanitized) + 1)
            sheet_id = _format_sheet_id(index_for_id)
            changed = True

        if sheet_id in seen_ids:
            continue

        created_at = str(entry.get("createdAt") or "").strip()
        if not created_at:
            created_at = now
            changed = True

        updated_at = str(entry.get("updatedAt") or "").strip()
        if not updated_at:
            updated_at = created_at or now
            changed = True

        has_row_count_key = "rowCount" in entry
        raw_row_count = entry.get("rowCount")
        if raw_row_count is None:
            raw_row_count = entry.get("row_count")
        row_count = _sanitize_dimension(raw_row_count, default=_DEFAULT_ROW_COUNT)
        if (
            not has_row_count_key
            or not isinstance(raw_row_count, int)
            or row_count != raw_row_count
        ):
            changed = True

        has_column_count_key = "columnCount" in entry
        raw_column_count = entry.get("columnCount")
        if raw_column_count is None:
            raw_column_count = entry.get("column_count")
        column_count = _sanitize_dimension(raw_column_count, default=_DEFAULT_COLUMN_COUNT)
        if (
            not has_column_count_key
            or not isinstance(raw_column_count, int)
            or column_count != raw_column_count
        ):
            changed = True

        raw_cards = entry.get("cards")
        cards = _sanitize_cards(raw_cards, row_count=row_count, column_count=column_count)
        if cards != raw_cards:
            changed = True

        raw_active_card = entry.get("lastActiveCardId")
        if raw_active_card is None:
            raw_active_card = entry.get("last_active_card_id")
        active_card = _sanitize_last_active_card_id(raw_active_card)
        valid_card_ids = {card.get("id") for card in cards if isinstance(card, dict)}
        if active_card and active_card not in valid_card_ids:
            active_card = cards[0]["id"] if cards else None
            changed = True

        sanitized.append(
            {
                "id": sheet_id,
                "name": name,
                "createdAt": created_at,
                "updatedAt": updated_at,
                "rowCount": row_count,
                "columnCount": column_count,
                "cards": cards,
                "lastActiveCardId": active_card,
            }
        )
        seen_ids.add(sheet_id)

        if name_index is not None and name_index > max_index:
            max_index = name_index

    if not sanitized:
        sanitized.append(_create_sheet_entry(1, now))
        max_index = max(max_index, 1)
        changed = True

    config["sheets"] = sanitized

    stored_last_active = config.get("lastActiveSheetId")
    if stored_last_active is None:
        stored_last_active = config.get("last_active_sheet_id")
    last_active = _sanitize_last_active_sheet_id(stored_last_active)

    valid_ids = {entry["id"] for entry in sanitized if isinstance(entry, dict)}
    if last_active and last_active not in valid_ids:
        last_active = sanitized[0]["id"] if sanitized else None
        changed = True

    if not last_active and sanitized and stored_last_active is None:
        last_active = sanitized[0]["id"]
        changed = True

    if config.get("lastActiveSheetId") != last_active:
        config["lastActiveSheetId"] = last_active
        changed = True

    if "last_active_sheet_id" in config:
        config.pop("last_active_sheet_id", None)
        changed = True

    if changed:
        save_sheet_config(safe_name, config)

    return config


def _extract_sheet_index(name: str) -> int | None:
    match = _SHEET_NAME_PATTERN.match(name or "")
    if match is None:
        return None
    try:
        return int(match.group(1))
    except (TypeError, ValueError):
        return None


def _format_sheet_name(index: int) -> str:
    return f"Sheet {index}"


def _format_sheet_id(index: int) -> str:
    return f"sheet-{index}"


def _create_sheet_entry(
    index: int,
    timestamp: str,
    *,
    row_count: int | None = None,
    column_count: int | None = None,
) -> Dict[str, Any]:
    name = _format_sheet_name(index)
    return {
        "id": _format_sheet_id(index),
        "name": name,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "rowCount": _sanitize_dimension(row_count, default=_DEFAULT_ROW_COUNT),
        "columnCount": _sanitize_dimension(column_count, default=_DEFAULT_COLUMN_COUNT),
        "cards": [],
        "lastActiveCardId": None,
    }


def _normalize_sheet_name(name: str | None) -> str:
    if name is None:
        return ""
    text = str(name).strip()
    text = re.sub(r"\s+", " ", text)
    return text


def _extract_sheet_id_index(sheet_id: str) -> int | None:
    match = _SHEET_ID_PATTERN.match(sheet_id or "")
    if match is None:
        return None
    try:
        return int(match.group(1))
    except (TypeError, ValueError):
        return None


def _next_sheet_identifiers(sheets: List[Dict[str, Any]]) -> Tuple[str, str]:
    max_id_index = 0
    max_name_index = 0

    for entry in sheets:
        if not isinstance(entry, dict):
            continue
        name_index = _extract_sheet_index(str(entry.get("name", "")))
        if name_index and name_index > max_name_index:
            max_name_index = name_index
        id_index = _extract_sheet_id_index(str(entry.get("id", "")))
        if id_index and id_index > max_id_index:
            max_id_index = id_index

    next_id_index = max(max_id_index, len(sheets)) + 1
    next_name_index = max(max_name_index, len(sheets)) + 1
    return _format_sheet_id(next_id_index), _format_sheet_name(next_name_index)


def add_sheet(
    file_name: str,
    name: str | None = None,
    *,
    row_count: int | None = None,
    column_count: int | None = None,
) -> Dict[str, Any]:
    """Append a new sheet entry to the configuration."""

    safe_name = Path(file_name).name
    config = ensure_sheet_config(safe_name)
    sheets: List[Dict[str, Any]] = list(config.get("sheets", []))

    sheet_id, default_name = _next_sheet_identifiers(sheets)
    now = _now_iso()
    sheet_name = _normalize_sheet_name(name) or default_name

    fallback_row = None
    fallback_column = None
    if sheets:
        last_entry = sheets[-1]
        if isinstance(last_entry, dict):
            fallback_row = last_entry.get("rowCount") or last_entry.get("row_count")
            fallback_column = last_entry.get("columnCount") or last_entry.get("column_count")

    normalized_row_count = _sanitize_dimension(
        row_count if row_count is not None else fallback_row,
        default=_DEFAULT_ROW_COUNT,
    )
    normalized_column_count = _sanitize_dimension(
        column_count if column_count is not None else fallback_column,
        default=_DEFAULT_COLUMN_COUNT,
    )

    entry = {
        "id": sheet_id,
        "name": sheet_name,
        "createdAt": now,
        "updatedAt": now,
        "rowCount": normalized_row_count,
        "columnCount": normalized_column_count,
        "cards": [],
    }

    sheets.append(entry)
    config["sheets"] = sheets
    current_active = _sanitize_last_active_sheet_id(config.get("lastActiveSheetId"))
    if not current_active:
        config["lastActiveSheetId"] = entry["id"]

    save_sheet_config(safe_name, config)
    return entry


def update_sheet(
    file_name: str,
    sheet_id: str,
    *,
    name: str | None = None,
    cards: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    """Update metadata for an existing sheet entry."""

    safe_name = Path(file_name).name
    config = ensure_sheet_config(safe_name)
    sheets: List[Dict[str, Any]] = list(config.get("sheets", []))

    normalized_id = str(sheet_id or "").strip()
    if not normalized_id:
        raise KeyError("Sheet identifier is required")

    target: Dict[str, Any] | None = None
    for entry in sheets:
        if isinstance(entry, dict) and str(entry.get("id", "")) == normalized_id:
            target = entry
            break

    if target is None:
        raise KeyError(f"Sheet {sheet_id!r} not found")

    sheet_name = _normalize_sheet_name(name)
    if sheet_name:
        target["name"] = sheet_name

    now = _now_iso()
    target["updatedAt"] = now

    row_count = _sanitize_dimension(target.get("rowCount"), default=_DEFAULT_ROW_COUNT)
    column_count = _sanitize_dimension(target.get("columnCount"), default=_DEFAULT_COLUMN_COUNT)
    target["rowCount"] = row_count
    target["columnCount"] = column_count

    if cards is not None:
        sanitized_cards = _sanitize_cards(cards, row_count=row_count, column_count=column_count)
        target["cards"] = sanitized_cards
    else:
        raw_cards = target.get("cards")
        sanitized_cards = (
            raw_cards
            if isinstance(raw_cards, list)
            else _sanitize_cards([], row_count=row_count, column_count=column_count)
        )
        if sanitized_cards is not raw_cards:
            target["cards"] = sanitized_cards

    valid_card_ids = {card.get("id") for card in sanitized_cards if isinstance(card, dict)}
    current_active_card = _sanitize_last_active_card_id(target.get("lastActiveCardId"))
    if current_active_card and current_active_card not in valid_card_ids:
        current_active_card = sanitized_cards[0]["id"] if sanitized_cards else None
    target["lastActiveCardId"] = current_active_card

    config["lastActiveSheetId"] = _sanitize_last_active_sheet_id(
        config.get("lastActiveSheetId")
    )

    save_sheet_config(safe_name, config)
    return target


def delete_sheet(file_name: str, sheet_id: str) -> Dict[str, Any]:
    """Remove a sheet entry from the configuration."""

    safe_name = Path(file_name).name
    config = ensure_sheet_config(safe_name)
    sheets: List[Dict[str, Any]] = list(config.get("sheets", []))

    normalized_id = str(sheet_id or "").strip()
    if not normalized_id:
        raise KeyError("Sheet identifier is required")

    filtered = [entry for entry in sheets if str(entry.get("id", "")) != normalized_id]
    if len(filtered) == len(sheets):
        raise KeyError(f"Sheet {sheet_id!r} not found")

    if not filtered:
        filtered.append(_create_sheet_entry(1, _now_iso()))

    config["sheets"] = filtered
    current_active = _sanitize_last_active_sheet_id(config.get("lastActiveSheetId"))
    if current_active == normalized_id:
        replacement = filtered[0]["id"] if filtered else None
        config["lastActiveSheetId"] = replacement
    else:
        config["lastActiveSheetId"] = current_active

    save_sheet_config(safe_name, config)
    return {"deleted": normalized_id, "sheets": filtered}


def set_last_active_card(
    file_name: str, sheet_id: str, card_id: str | None
) -> Dict[str, Any]:
    """Saves last active card ID for sheet."""

    safe_name = Path(file_name).name
    config = ensure_sheet_config(safe_name)
    sheets: List[Dict[str, Any]] = list(config.get("sheets", []))

    normalized_sheet_id = str(sheet_id or "").strip()
    if not normalized_sheet_id:
        raise KeyError("Sheet identifier is required")

    target: Dict[str, Any] | None = None
    for entry in sheets:
        if isinstance(entry, dict) and str(entry.get("id", "")) == normalized_sheet_id:
            target = entry
            break

    if target is None:
        raise KeyError(f"Sheet {sheet_id!r} not found")

    normalized_card_id = _sanitize_last_active_card_id(card_id)
    valid_ids = {
        card.get("id")
        for card in target.get("cards", [])
        if isinstance(card, dict)
    }

    if normalized_card_id and normalized_card_id not in valid_ids:
        raise KeyError(f"Card {card_id!r} not found")

    if target.get("lastActiveCardId") != normalized_card_id:
        target["lastActiveCardId"] = normalized_card_id
        save_sheet_config(safe_name, config)

    return target


def set_last_active_sheet(file_name: str, sheet_id: str | None) -> Dict[str, Any]:
    """Saves last active sheet ID for project."""

    safe_name = Path(file_name).name
    config = ensure_sheet_config(safe_name)
    sheets: List[Dict[str, Any]] = list(config.get("sheets", []))

    normalized_id = _sanitize_last_active_sheet_id(sheet_id)
    valid_ids = {entry.get("id") for entry in sheets if isinstance(entry, dict)}

    if normalized_id and normalized_id not in valid_ids:
        raise KeyError(f"Sheet {sheet_id!r} not found")

    if config.get("lastActiveSheetId") != normalized_id:
        config["lastActiveSheetId"] = normalized_id
        save_sheet_config(safe_name, config)

    return config


__all__ = [
    "ensure_sheet_config",
    "load_sheet_config",
    "save_sheet_config",
    "sheet_config_path",
    "add_sheet",
    "update_sheet",
    "delete_sheet",
    "set_last_active_card",
    "set_last_active_sheet",
]

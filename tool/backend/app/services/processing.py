"""Processing service helpers coordinating scatter plot precomputation."""

from __future__ import annotations

from dataclasses import dataclass
import logging
from pathlib import Path
from typing import Dict, Mapping, Optional, Sequence, Tuple

from processing import scatterplot

LOGGER = logging.getLogger(__name__)


@dataclass
class ScatterJobState:
    """Stored status information for a scatter plot card."""

    status: str
    method: Optional[str] = None
    job_id: Optional[str] = None
    message: Optional[str] = None
    payload: Optional[Mapping[str, object]] = None


_SCATTER_JOB_REGISTRY: Dict[Tuple[str, str, str], ScatterJobState] = {}


def handle_sheet_update(project_name: str, sheet_entry: Mapping[str, object]) -> None:
    """Validate scatter cards and trigger dimensionality reduction if required."""

    safe_project = _normalize_project_name(project_name)
    sheet_id = _normalize_identifier(sheet_entry.get("id"))
    if not sheet_id:
        return

    cards: Sequence[Mapping[str, object]] = []
    raw_cards = sheet_entry.get("cards")
    if isinstance(raw_cards, list):
        cards = [entry for entry in raw_cards if isinstance(entry, Mapping)]

    active_card_ids = {card_id for card_id, _ in _iterate_scatter_cards(cards)}

    # Clean up deleted cards from registry
    _purge_missing_cards(safe_project, sheet_id, active_card_ids)

    for card_id, configuration in _iterate_scatter_cards(cards):
        try:
            parsed = scatterplot.parse_card_configuration(configuration)
        except scatterplot.ScatterConfigurationError as exc:
            LOGGER.error(
                "Invalid scatter configuration detected during save",
                extra={"project": safe_project, "sheet_id": sheet_id, "card_id": card_id},
            )
            _SCATTER_JOB_REGISTRY[(safe_project, sheet_id, card_id)] = ScatterJobState(
                status="error",
                message=str(exc) or "Scatter configuration is invalid.",
            )
            continue

        if parsed.requires_reduction:
            try:
                result = scatterplot.prepare_precompute_job(
                    safe_project, sheet_id, card_id, parsed
                )
            except scatterplot.ScatterConfigurationError as exc:
                LOGGER.error(
                    "Failed to schedule dimensionality reduction",
                    extra={
                        "project": safe_project,
                        "sheet_id": sheet_id,
                        "card_id": card_id,
                        "method": parsed.reduction,
                    },
                )
                _SCATTER_JOB_REGISTRY[(safe_project, sheet_id, card_id)] = ScatterJobState(
                    status="error",
                    method=parsed.reduction,
                    message=str(exc) or "Dimensionality reduction could not be scheduled.",
                )
                continue

            _SCATTER_JOB_REGISTRY[(safe_project, sheet_id, card_id)] = ScatterJobState(
                status=result.status or "pending",
                method=result.method,
                job_id=result.job_id,
                message=result.message,
            )
        else:
            _SCATTER_JOB_REGISTRY[(safe_project, sheet_id, card_id)] = ScatterJobState(
                status="ready",
                method=None,
            )


def record_scatter_payload(
    project_name: str,
    sheet_id: str,
    card_id: str,
    payload: Mapping[str, object],
    *,
    status: str = "ready",
    method: Optional[str] = None,
    message: Optional[str] = None,
) -> None:
    """Store the result payload for a scatter plot card."""

    key = (
        _normalize_project_name(project_name),
        _normalize_identifier(sheet_id),
        _normalize_identifier(card_id),
    )
    if not all(key):
        return

    _SCATTER_JOB_REGISTRY[key] = ScatterJobState(
        status=status,
        method=method,
        message=message,
        payload=dict(payload),
    )


def get_scatter_status(project_name: str, sheet_id: str, card_id: str) -> Optional[ScatterJobState]:
    """Gets scatter job status for card."""

    key = (
        _normalize_project_name(project_name),
        _normalize_identifier(sheet_id),
        _normalize_identifier(card_id),
    )
    if not all(key):
        return None
    return _SCATTER_JOB_REGISTRY.get(key)


def clear_project(project_name: str) -> None:
    """Remove all scatter job entries associated with a project."""

    safe_project = _normalize_project_name(project_name)
    keys_to_remove = [key for key in _SCATTER_JOB_REGISTRY if key[0] == safe_project]
    for key in keys_to_remove:
        _SCATTER_JOB_REGISTRY.pop(key, None)


def _purge_missing_cards(project: str, sheet_id: str, current_ids: Sequence[str]) -> None:
    current = {entry for entry in current_ids if entry}
    keys_to_remove = [
        key
        for key in _SCATTER_JOB_REGISTRY
        if key[0] == project and key[1] == sheet_id and key[2] not in current
    ]
    for key in keys_to_remove:
        _SCATTER_JOB_REGISTRY.pop(key, None)


def _iterate_scatter_cards(cards: Sequence[Mapping[str, object]]):
    for entry in cards:
        card_id = _normalize_identifier(entry.get("id"))
        if not card_id:
            continue
        configuration = entry.get("configuration")
        if not isinstance(configuration, Mapping):
            continue
        chart_type = str(
            configuration.get("chartType") or configuration.get("chart_type") or ""
        ).strip()
        if chart_type.lower() != "scatter":
            continue
        yield card_id, configuration


def _normalize_project_name(project_name: str) -> str:
    return Path(project_name or "").name


def _normalize_identifier(value: object) -> str:
    if value is None:
        return ""
    try:
        text = str(value).strip()
    except Exception:
        return ""
    return text


__all__ = [
    "ScatterJobState",
    "clear_project",
    "get_scatter_status",
    "handle_sheet_update",
    "record_scatter_payload",
]


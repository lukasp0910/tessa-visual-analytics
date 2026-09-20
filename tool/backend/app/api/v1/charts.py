"""Routes that expose chart data queries for dashboard visualizations."""

from __future__ import annotations

from pathlib import Path as PathlibPath
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from processing.linechart import (
    ColumnNotFoundError,
    DatasetNotFoundError,
    EmptyDatasetError,
    InvalidDatasetError,
    get_linechart_data,
)
from processing import scatterplot

from app.services import processing as processing_service, progress as progress_service
from app.storage import project_storage

router = APIRouter(prefix="/charts")


class TsneControlRequest(BaseModel):
    project_id: str
    sheet_id: str
    card_id: str
    session_id: str
    action: str


class ScatterClusterRequest(BaseModel):
    points: List[float]
    eps: float = Field(0.13, gt=0)
    min_samples: int = Field(130, ge=1, alias="minSamples")
    dimension: int = Field(2, ge=2, le=3)
    row_indices: Optional[List[int]] = Field(None, alias="rowIndices")


ALLOWED_REDUCTIONS = {"pca", "umap", "tsne"}


def _normalize_query_sequence(values: List[str] | None) -> List[str]:
    if not values:
        return []
    result: List[str] = []
    seen: set[str] = set()
    for entry in values:
        if entry is None:
            continue
        try:
            text = str(entry).strip()
        except Exception:  # pragma: no cover - defensive fallback
            continue
        if not text or text in seen:
            continue
        result.append(text)
        seen.add(text)
    return result


def _normalize_optional_string(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        text = str(value).strip()
    except Exception:  # pragma: no cover - defensive fallback
        return None
    return text or None


def _normalize_query_dimension(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        candidate = int(value)
    except (TypeError, ValueError):
        return None
    return candidate if candidate in (2, 3) else None


def _normalize_query_reduction(value: str | None) -> str | None:
    text = _normalize_optional_string(value)
    if not text:
        return None
    lowered = text.lower()
    return lowered if lowered in ALLOWED_REDUCTIONS else None


def _normalize_subject_value(value: str | None) -> str | None:
    text = _normalize_optional_string(value)
    if not text:
        return None
    if text.lower() == "all":
        return None
    return text


@router.get("/line")
async def read_line_chart(
    dataset: str = Query(..., min_length=1),
    time_column: str | None = Query(None, min_length=1),
    measure_column: List[str] = Query(..., min_length=1),
    subject_id: str | None = Query(None),
):
    """Return timestamp/value pairs for a configured line chart.

    When subject_id is provided and the dataset belongs to a multi-subject array,
    the response is filtered to rows for the selected subject (first column = subject id).
    """

    try:
        series = get_linechart_data(dataset, time_column, measure_column, subject_id)
    except InvalidDatasetError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_DATASET",
                "message": str(exc) or "Dataset identifier is invalid.",
            },
        ) from exc
    except DatasetNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DATASET_NOT_FOUND",
                "message": str(exc) or "Dataset could not be located.",
            },
        ) from exc
    except ColumnNotFoundError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "COLUMN_NOT_FOUND",
                "message": str(exc) or "Requested column is unavailable.",
            },
        ) from exc
    except EmptyDatasetError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "NO_DATA",
                "message": str(exc) or "Dataset does not contain any rows.",
            },
        ) from exc

    return {
        "timestamps": series.timestamps,
        "values": series.values,
        "series": [
            {
                "key": entry.key,
                "label": entry.label,
                "columnIndex": entry.column_index,
                "values": entry.values,
            }
            for entry in series.series
        ],
    }


@router.get("/scatter")
async def read_scatter_chart(
    project_id: str = Query(..., min_length=1),
    sheet_id: str = Query(..., min_length=1),
    card_id: str = Query(..., min_length=1),
    column_override: List[str] | None = Query(None, alias="column"),
    dimension_override: int | None = Query(None, alias="dimension"),
    reduction_override: str | None = Query(None, alias="reduction"),
    subject_override: str | None = Query(None, alias="subject"),
    subject_label_override: str | None = Query(None, alias="subject_label"),
    multi_subject_override: bool | None = Query(None, alias="multi_subject"),
    column_label_override: List[str] | None = Query(None, alias="column_label"),
    n_neighbors: int | None = Query(None, ge=5, le=50, description="Number of neighbors for UMAP (5-50)"),
    perplexity: float | None = Query(None, ge=5, le=100, description="Perplexity for t-SNE (5-100)"),
    learning_rate: float | None = Query(None, ge=50, le=2000, description="Learning rate for t-SNE (50-2000)"),
):
    """Return point coordinates for a configured scatter plot."""

    project_name = PathlibPath(project_id).name
    directory = project_storage.project_directory(project_name)
    if not directory.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    config = project_storage.ensure_sheet_config(project_name)
    sheets = config.get("sheets") or []
    target_sheet = None
    for entry in sheets:
        if isinstance(entry, dict) and str(entry.get("id")) == sheet_id:
            target_sheet = entry
            break
    if target_sheet is None:
        raise HTTPException(status_code=404, detail="Sheet not found")

    raw_cards = target_sheet.get("cards") or []
    target_card = None
    for card in raw_cards:
        if isinstance(card, dict) and str(card.get("id")) == card_id:
            target_card = card
            break
    if target_card is None:
        raise HTTPException(status_code=404, detail="Card not found")

    configuration = target_card.get("configuration")
    if not isinstance(configuration, dict):
        raise HTTPException(status_code=400, detail="Scatter configuration is missing")

    try:
        parsed = scatterplot.parse_card_configuration(configuration)
    except scatterplot.ScatterConfigurationError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_SCATTER_CONFIGURATION",
                "message": str(exc) or "Scatter plot configuration is invalid.",
            },
        ) from exc

    dataset_identifier = parsed.dataset_id
    dataset_project = project_name
    dataset_array = dataset_identifier

    if "::" in dataset_identifier:
        raw_project, raw_array = dataset_identifier.split("::", 1)
        dataset_project = raw_project.strip() or project_name
        dataset_array = raw_array.strip()
    else:
        dataset_array = dataset_identifier.strip()

    if dataset_project.strip() != project_name:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_DATASET",
                "message": "Scatter plot references a dataset from a different project.",
            },
        )

    if not dataset_array:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_DATASET",
                "message": "Scatter plot references an unknown dataset.",
            },
        )

    if "::" not in dataset_identifier:
        parsed.dataset_id = f"{project_name}::{dataset_array}"

    parsed.subject_id = _normalize_subject_value(parsed.subject_id)
    parsed.subject_label = _normalize_optional_string(parsed.subject_label)

    original_columns = tuple(parsed.columns)
    original_dimension = parsed.dimension
    original_reduction = (parsed.reduction or "").lower()
    original_subject = parsed.subject_id
    original_subject_label = parsed.subject_label
    original_multi_subject = parsed.multi_subject
    original_column_labels = tuple(
        label
        for label in (
            _normalize_optional_string(label) for label in parsed.column_labels
        )
        if label
    )

    override_columns = _normalize_query_sequence(column_override)
    override_column_labels = _normalize_query_sequence(column_label_override)
    override_dimension = _normalize_query_dimension(dimension_override)
    override_reduction = _normalize_query_reduction(reduction_override)
    override_subject = _normalize_subject_value(subject_override)
    override_subject_label = _normalize_optional_string(subject_label_override)

    columns_overridden = False
    if override_columns:
        parsed.columns = override_columns
        columns_overridden = True

    if override_dimension is not None:
        parsed.dimension = override_dimension

    if reduction_override is not None:
        parsed.reduction = override_reduction

    if subject_override is not None:
        parsed.subject_id = override_subject

    if subject_label_override is not None:
        parsed.subject_label = override_subject_label

    if multi_subject_override is not None:
        parsed.multi_subject = bool(multi_subject_override)

    if not parsed.multi_subject:
        parsed.subject_id = None
        parsed.subject_label = None

    if override_column_labels:
        parsed.column_labels = override_column_labels[: len(parsed.columns)]
    elif columns_overridden and parsed.column_labels:
        parsed.column_labels = parsed.column_labels[: len(parsed.columns)]

    parsed.column_labels = [
        label
        for label in (_normalize_optional_string(label) for label in parsed.column_labels)
        if label
    ]

    if parsed.dimension not in (2, 3):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_SCATTER_CONFIGURATION",
                "message": "Scatter plots support only 2D or 3D.",
            },
        )

    if len(parsed.columns) < 2:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_SCATTER_CONFIGURATION",
                "message": "Scatter plots require at least two columns.",
            },
        )

    if len(parsed.columns) < parsed.dimension:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_SCATTER_CONFIGURATION",
                "message": "Not enough columns selected for the requested dimension.",
            },
        )

    if parsed.requires_reduction:
        parsed.reduction = (parsed.reduction or "pca").lower() or None
        if parsed.reduction not in ALLOWED_REDUCTIONS:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "INVALID_SCATTER_CONFIGURATION",
                    "message": "Unsupported dimensionality reduction method.",
                },
            )
    else:
        parsed.reduction = None

    final_columns = tuple(parsed.columns)
    final_dimension = parsed.dimension
    final_reduction = (parsed.reduction or "").lower()
    final_subject = parsed.subject_id
    final_subject_label = parsed.subject_label
    final_multi_subject = parsed.multi_subject
    final_column_labels = tuple(parsed.column_labels)

    config_changed = (
        final_columns != original_columns
        or final_dimension != original_dimension
        or final_reduction != original_reduction
        or final_subject != original_subject
        or final_subject_label != original_subject_label
        or final_multi_subject != original_multi_subject
        or final_column_labels != original_column_labels
    )

    if parsed.requires_reduction:
        if (parsed.reduction or "").lower() == "tsne":
            job_id = f"tsne::{project_name}::{sheet_id}::{card_id}"
            try:
                return await scatterplot.start_tsne_session(
                    parsed,
                    project_name=project_name,
                    sheet_id=sheet_id,
                    card_id=card_id,
                    job_id=job_id,
                    perplexity=perplexity,
                    learning_rate=learning_rate,
                )
            except scatterplot.ScatterDataError as exc:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "SCATTER_DATA_UNAVAILABLE",
                        "message": str(exc) or "Scatter plot data could not be generated.",
                    },
                ) from exc

        status_entry = None
        if not config_changed:
            status_entry = processing_service.get_scatter_status(
                project_name, sheet_id, card_id
            )
        if (
            status_entry
            and status_entry.status == "ready"
            and status_entry.payload
        ):
            payload = dict(status_entry.payload)
            payload.setdefault("dimension", parsed.dimension)
            payload.setdefault("status", "ready")
            if parsed.column_labels and "columnLabels" not in payload:
                payload["columnLabels"] = parsed.column_labels
            return payload

        if (parsed.reduction or "").lower() in ALLOWED_REDUCTIONS:
            method = (parsed.reduction or "").lower()
            job_id = f"{method}::{project_name}::{sheet_id}::{card_id}"

            try:
                scatter_data = await scatterplot.build_reduced_scatter_data(
                    parsed, job_id=job_id, n_neighbors=n_neighbors
                )
            except scatterplot.ScatterDataError as exc:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "SCATTER_DATA_UNAVAILABLE",
                        "message": str(exc) or "Scatter plot data could not be generated.",
                    },
                ) from exc

            response_payload = {
                "status": "ready",
                "dimension": scatter_data.dimension,
                "points": [
                    {"rowIndex": point.row_index, "coordinates": point.coordinates}
                    for point in scatter_data.points
                ],
                "columns": [
                    {
                        "key": column.key,
                        "label": column.label,
                        "columnIndex": column.column_index,
                    }
                    for column in scatter_data.columns
                ],
            }

            if scatter_data.subject:
                response_payload["subject"] = scatter_data.subject
            if scatter_data.subject_mapping:
                response_payload["subjectMapping"] = scatter_data.subject_mapping
            if parsed.column_labels:
                response_payload["columnLabels"] = parsed.column_labels
            if scatter_data.pca_metadata:
                response_payload["pcaMetadata"] = scatter_data.pca_metadata
            response_payload["multiSubject"] = parsed.multi_subject

            if not config_changed:
                processing_service.record_scatter_payload(
                    project_name,
                    sheet_id,
                    card_id,
                    response_payload,
                    status="ready",
                    method=method,
                )
            return response_payload

        status_payload = {
            "status": status_entry.status if status_entry else "pending",
            "dimension": parsed.dimension,
            "method": status_entry.method if status_entry else parsed.reduction,
        }
        if status_entry and status_entry.job_id:
            status_payload["jobId"] = status_entry.job_id
        if status_entry and status_entry.message:
            status_payload["message"] = status_entry.message
        else:
            status_payload["message"] = "Dimensionality reduction in progress."
        return status_payload

    try:
        scatter_data = scatterplot.build_direct_scatter_data(parsed)
    except scatterplot.ScatterDataError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "SCATTER_DATA_UNAVAILABLE",
                "message": str(exc) or "Scatter plot data could not be generated.",
            },
        ) from exc

    response_payload = {
        "status": "ready",
        "dimension": scatter_data.dimension,
        "points": [
            {"rowIndex": point.row_index, "coordinates": point.coordinates}
            for point in scatter_data.points
        ],
        "columns": [
            {
                "key": column.key,
                "label": column.label,
                "columnIndex": column.column_index,
            }
            for column in scatter_data.columns
        ],
    }

    if scatter_data.subject:
        response_payload["subject"] = scatter_data.subject
    if scatter_data.subject_mapping:
        response_payload["subjectMapping"] = scatter_data.subject_mapping
    if parsed.column_labels:
        response_payload["columnLabels"] = parsed.column_labels
    response_payload["multiSubject"] = parsed.multi_subject

    return response_payload


@router.post("/scatter/cluster")
async def cluster_scatter_points(request: ScatterClusterRequest):
    """Cluster 2D scatter plot points with DBSCAN."""

    if request.dimension != 2:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_SCATTER_CONFIGURATION",
                "message": "DBSCAN clustering is only supported for 2D scatter plots.",
            },
        )

    points = request.points or []
    if not points:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_SCATTER_DATA",
                "message": "No scatter points were provided for clustering.",
            },
        )

    point_count = len(points) // request.dimension
    if len(points) % request.dimension != 0:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_SCATTER_DATA",
                "message": "Scatter point array does not align with the target dimension.",
            },
        )

    if request.row_indices and len(request.row_indices) != point_count:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_SCATTER_DATA",
                "message": "Row index count does not match scatter point count.",
            },
        )

    try:
        labels = scatterplot.cluster_dbscan(
            points,
            eps=request.eps,
            min_samples=request.min_samples,
            dimension=request.dimension,
        )
    except scatterplot.ScatterDataError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "SCATTER_DATA_UNAVAILABLE",
                "message": str(exc) or "Scatter plot clustering failed.",
            },
        ) from exc

    response_payload = {
        "algorithm": "dbscan",
        "dimension": request.dimension,
        "eps": request.eps,
        "minSamples": request.min_samples,
        "labels": labels.tolist(),
    }
    if request.row_indices:
        response_payload["rowIndices"] = request.row_indices

    return response_payload


@router.get("/scatter/progress")
async def read_scatter_progress(
    project_id: str = Query(..., min_length=1),
    sheet_id: str = Query(..., min_length=1),
    card_id: str = Query(..., min_length=1),
):
    """Return the latest dimensionality reduction progress for a scatter card."""

    project_name = PathlibPath(project_id).name
    sheet_key = _normalize_optional_string(sheet_id)
    card_key = _normalize_optional_string(card_id)
    if not sheet_key or not card_key:
        raise HTTPException(status_code=400, detail="Scatter identifiers are required.")

    status_entry = processing_service.get_scatter_status(project_name, sheet_key, card_key)
    job_candidates: List[str] = []
    if status_entry and status_entry.job_id:
        job_candidates.append(status_entry.job_id)

    for method in ALLOWED_REDUCTIONS:
        job_candidates.append(f"{method}::{project_name}::{sheet_key}::{card_key}")

    seen: set[str] = set()
    for candidate in job_candidates:
        normalized = (candidate or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        progress_entry = progress_service.get_progress(normalized)
        if not progress_entry:
            continue

        percentage = int(progress_entry.get("percentage") or 0)
        percentage = max(0, min(100, percentage))
        status = str(progress_entry.get("status") or "running")
        message = str(progress_entry.get("message") or "Processing…")

        payload = {
            "jobId": normalized,
            "percentage": percentage,
            "status": status,
            "message": message,
        }

        method_name = normalized.split("::", 1)[0]
        if method_name in ALLOWED_REDUCTIONS:
            payload["method"] = method_name

        return payload

    raise HTTPException(
        status_code=404,
        detail={
            "code": "NO_ACTIVE_JOB",
            "message": "No active dimensionality reduction job found for this card.",
        },
    )


@router.get("/scatter/tsne/state")
async def read_tsne_state(
    project_id: str = Query(..., min_length=1),
    sheet_id: str = Query(..., min_length=1),
    card_id: str = Query(..., min_length=1),
    session_id: str = Query(..., min_length=1),
    since_iteration: int | None = Query(None, alias="since_iteration"),
):
    """Return the latest live t-SNE state for a scatter card."""

    project_name = PathlibPath(project_id).name
    normalized_sheet = _normalize_optional_string(sheet_id)
    normalized_card = _normalize_optional_string(card_id)
    if not normalized_sheet or not normalized_card:
        raise HTTPException(status_code=400, detail="Scatter identifiers are required.")

    try:
        return scatterplot.get_tsne_session_state(
            session_id,
            project_name=project_name,
            sheet_id=normalized_sheet,
            card_id=normalized_card,
            since_iteration=since_iteration,
        )
    except scatterplot.ScatterDataError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "TSNE_SESSION_UNAVAILABLE",
                "message": str(exc) or "t-SNE session is not available.",
            },
        ) from exc


@router.post("/scatter/tsne/control")
async def control_tsne_state(command: TsneControlRequest):
    """Apply a control command to a live t-SNE session."""

    project_name = PathlibPath(command.project_id).name
    normalized_sheet = _normalize_optional_string(command.sheet_id)
    normalized_card = _normalize_optional_string(command.card_id)
    if not normalized_sheet or not normalized_card:
        raise HTTPException(status_code=400, detail="Scatter identifiers are required.")

    try:
        return scatterplot.control_tsne_session(
            command.session_id,
            project_name=project_name,
            sheet_id=normalized_sheet,
            card_id=normalized_card,
            action=command.action,
        )
    except scatterplot.ScatterDataError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "TSNE_CONTROL_FAILED",
                "message": str(exc) or "Unable to control t-SNE session.",
            },
        ) from exc


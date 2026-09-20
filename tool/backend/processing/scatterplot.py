"""Scatter plot data preparation and dimensionality reduction utilities."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
import logging
import math
import re
import time
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np
from sklearn.cluster import DBSCAN
from sklearn.preprocessing import StandardScaler

from . import pca, tsne_reduction, umap_reduction

LOGGER = logging.getLogger(__name__)


class ScatterConfigurationError(Exception):
    """Config is messed up."""


class ScatterDataError(Exception):
    """Can't generate scatter plot data."""


_DATASET_DELIMITER = "::"
_COLUMN_PATTERN = re.compile(r"^column\s+(?P<index>\d+)$", re.IGNORECASE)
_ALLOWED_DIMENSIONS = {2, 3}
_REDUCTION_METHODS = {"pca": pca.reduce, "umap": umap_reduction.reduce}
_COMPONENT_METADATA_BUILDERS = {
    "pca": pca.component_metadata,
    "umap": umap_reduction.component_metadata,
    "tsne": tsne_reduction.component_metadata,
}
_REDUCTION_PREPARE = {"pca": pca.prepare, "umap": umap_reduction.prepare}
_ALLOWED_REDUCTIONS = set(_COMPONENT_METADATA_BUILDERS)


@dataclass
class ScatterplotConfig:
    """Scatter plot config from sheet card."""

    chart_type: str
    dataset_id: str
    columns: List[str]
    dimension: int
    reduction: Optional[str]
    subject_id: Optional[str]
    multi_subject: bool
    subject_label: Optional[str]
    column_labels: List[str]

    @property
    def requires_reduction(self) -> bool:
        return len(self.columns) > self.dimension


@dataclass
class ScatterplotColumn:
    """Metadata describing a single column present in the scatter plot."""

    key: str
    label: str
    column_index: int


@dataclass
class ScatterplotPoint:
    """Coordinate container for a single scatter plot point."""

    row_index: int
    coordinates: List[object]


@dataclass
class ScatterplotData:
    """Prepared data returned to the Explore mode client."""

    dimension: int
    points: List[ScatterplotPoint]
    columns: List[ScatterplotColumn]
    subject: Optional[Dict[str, str]] = None
    pca_metadata: Optional[Dict[str, object]] = None
    subject_mapping: Optional[Dict[str, List[int]]] = None


@dataclass
class ScatterPrecomputeResult:
    """Metadata describing the triggered dimensionality reduction job."""

    method: str
    status: str
    job_id: Optional[str]
    message: Optional[str] = None


@dataclass
class PreparedReductionInputs:
    """Data ready for dimensionality reduction."""

    matrix: np.ndarray
    target_dimension: int
    subject_payload: Optional[Dict[str, str]]
    row_indices: List[int]
    subject_mapping: Optional[Dict[str, List[int]]] = None


@dataclass
class ScatterTsneContext:
    """Tracks active live t-SNE sessions for scatter plots."""

    session_id: str
    project_name: str
    sheet_id: str
    card_id: str
    columns: List[ScatterplotColumn]
    column_labels: List[str]
    subject: Optional[Dict[str, str]]
    dimension: int
    row_indices: List[int]
    created_at: float = field(default_factory=time.monotonic)
    updated_at: float = field(default_factory=time.monotonic)


_TSNE_SESSIONS: Dict[str, ScatterTsneContext] = {}
_TSNE_SESSION_TTL = 10 * 60.0  # Seconds
_TSNE_CLEANUP_INTERVAL = 30.0
_LAST_TSNE_CLEANUP = 0.0


def parse_card_configuration(configuration: Mapping[str, object]) -> ScatterplotConfig:
    """Parses and validates scatter config from card."""

    if not isinstance(configuration, Mapping):
        raise ScatterConfigurationError("Card configuration must be a mapping")

    chart_type = str(configuration.get("chartType") or configuration.get("chart_type") or "").strip()
    if chart_type.lower() != "scatter":
        raise ScatterConfigurationError("Configuration does not describe a scatter plot")

    dataset_id = str(
        configuration.get("dataSourceId")
        or configuration.get("data_source_id")
        or ""
    ).strip()
    if not dataset_id:
        raise ScatterConfigurationError("Scatter plots require a data source identifier")

    field_values_raw = configuration.get("fieldValues") or configuration.get("field_values")
    if not isinstance(field_values_raw, Mapping):
        raise ScatterConfigurationError("Scatter plot field values are missing")

    columns = _parse_columns(field_values_raw.get("columns"))
    if len(columns) < 2:
        raise ScatterConfigurationError("Scatter plots require at least two columns")

    dimension = _parse_dimension(field_values_raw.get("dimension"))
    if dimension not in _ALLOWED_DIMENSIONS:
        raise ScatterConfigurationError("Scatter plots support only 2D or 3D")

    if len(columns) < dimension:
        raise ScatterConfigurationError("Not enough columns selected for the requested dimension")

    reduction = _parse_reduction(field_values_raw.get("reduction"))
    if len(columns) > dimension and reduction is None:
        raise ScatterConfigurationError("Dimensionality reduction method is required when more columns than the target dimension are selected")

    subject_id = _parse_optional_string(field_values_raw.get("subject"))
    multi_subject = bool(field_values_raw.get("multiSubject") or field_values_raw.get("multi_subject") or False)
    subject_label = _parse_optional_string(
        field_values_raw.get("subjectLabel") or field_values_raw.get("subject_label")
    )
    column_labels = _parse_column_labels(field_values_raw.get("columnLabels") or field_values_raw.get("column_labels"))

    return ScatterplotConfig(
        chart_type="scatter",
        dataset_id=dataset_id,
        columns=columns,
        dimension=dimension,
        reduction=reduction,
        subject_id=subject_id,
        multi_subject=bool(multi_subject),
        subject_label=subject_label,
        column_labels=column_labels,
    )


def prepare_precompute_job(
    project_name: str,
    sheet_id: str,
    card_id: str,
    config: ScatterplotConfig,
) -> ScatterPrecomputeResult:
    """Trigger the configured dimensionality reduction job."""

    method = (config.reduction or "").lower()
    if method not in _ALLOWED_REDUCTIONS:
        raise ScatterConfigurationError(f"Unsupported dimensionality reduction method: {config.reduction!r}")

    if method == "tsne":
        return ScatterPrecomputeResult(
            method="tsne",
            status="ready",
            job_id=None,
            message="t-SNE reduction will be computed interactively.",
        )

    project_key = Path(project_name).name
    prepare = _REDUCTION_PREPARE.get(method)
    if prepare is None:
        raise ScatterConfigurationError(f"Unsupported dimensionality reduction method: {config.reduction!r}")

    result = prepare(
        project=project_key,
        dataset=config.dataset_id,
        sheet_id=sheet_id,
        card_id=card_id,
        columns=config.columns,
        dimension=config.dimension,
        subject=config.subject_id,
        multi_subject=config.multi_subject,
    )

    status = str(result.get("status") or "ready").lower()
    job_id = _parse_optional_string(result.get("jobId") or result.get("job_id"))
    message = _parse_optional_string(
        result.get("message") or "Dimensionality reduction will be computed on demand."
    )

    return ScatterPrecomputeResult(method=method, status=status, job_id=job_id, message=message)


def build_direct_scatter_data(config: ScatterplotConfig) -> ScatterplotData:
    """Builds scatter points without reduction (2D/3D only)."""

    from app.services import metadata, visibility

    project_name, array_entry = _resolve_dataset(config.dataset_id)
    array = array_entry["array"]
    array_id = array_entry["id"]

    if array.ndim == 0:
        row_count = 1
    else:
        row_count = int(array.shape[0]) if array.shape else 0

    if row_count <= 0:
        raise ScatterDataError("Dataset does not contain any rows")

    reshaped = array.reshape(row_count, -1)
    column_count = int(reshaped.shape[1]) if reshaped.ndim == 2 else 1

    # Compute subject mapping for multi-subject arrays (before filtering)
    subject_mapping: Optional[Dict[str, List[int]]] = None
    if config.multi_subject and column_count >= 1 and not config.subject_id:
        subject_mapping = _compute_subject_mapping(reshaped)

    if config.subject_id and config.multi_subject and column_count >= 1:
        reshaped, row_count = _filter_subject_rows(reshaped, config.subject_id)
        if row_count <= 0:
            raise ScatterDataError("No rows available for the selected subject")

    default_columns = [f"Column {index + 1}" for index in range(column_count)] or ["Value"]
    custom_names = visibility.array_column_names(project_name, array_id)
    resolved_columns = metadata.apply_column_names(default_columns, custom_names)

    normalized_identifiers = _normalize_column_identifiers(config.columns)
    selected_indices = _resolve_column_indices(normalized_identifiers, resolved_columns)

    if len(selected_indices) != config.dimension:
        raise ScatterDataError("Scatter plot requires exactly one column per dimension")

    column_metadata: List[ScatterplotColumn] = []
    for index in selected_indices:
        label = str(resolved_columns[index] or "").strip() or f"Column {index + 1}"
        column_metadata.append(
            ScatterplotColumn(
                key=f"column_{index + 1}",
                label=label,
                column_index=index + 1,
            )
        )

    normalized_columns = [_normalize_column_values(reshaped[:, index]) for index in selected_indices]

    points: List[ScatterplotPoint] = []
    for row_index in range(row_count):
        coordinates = [column[row_index] for column in normalized_columns]
        points.append(ScatterplotPoint(row_index=row_index, coordinates=coordinates))

    subject_payload: Optional[Dict[str, str]] = None
    if config.subject_id:
        subject_label = config.subject_label or config.subject_id
        subject_payload = {"id": config.subject_id, "label": subject_label}

    return ScatterplotData(
        dimension=config.dimension,
        points=points,
        columns=column_metadata,
        subject=subject_payload,
        subject_mapping=subject_mapping,
    )


def cluster_dbscan(
    points: Sequence[float] | np.ndarray,
    *,
    eps: float,
    min_samples: int,
    dimension: int = 2,
) -> np.ndarray:
    """Cluster 2D scatter plot points using DBSCAN."""

    if dimension != 2:
        raise ScatterDataError("DBSCAN clustering is only supported for 2D scatter plots.")

    if not isinstance(eps, (int, float)) or eps <= 0:
        raise ScatterDataError("EPS must be a positive number.")

    try:
        min_samples = int(min_samples)
    except (TypeError, ValueError) as exc:
        raise ScatterDataError("Min samples must be a positive integer.") from exc
    if min_samples < 1:
        raise ScatterDataError("Min samples must be at least 1.")

    array = np.asarray(points, dtype=np.float32)
    if array.size == 0:
        raise ScatterDataError("No scatter points were provided for clustering.")

    if array.ndim == 1:
        if array.size % dimension != 0:
            raise ScatterDataError("Flattened scatter points do not align with the target dimension.")
        array = array.reshape(-1, dimension)
    elif array.ndim == 2:
        if array.shape[1] != dimension:
            raise ScatterDataError("Scatter points do not match the target dimension.")
    else:
        raise ScatterDataError("Scatter points must be a 1D or 2D array.")

    if not np.isfinite(array).all():
        raise ScatterDataError("Scatter points contain non-finite values.")

    # Normalize feature scales so eps behaves consistently across axes
    scaled = StandardScaler().fit_transform(array)

    dbscan = DBSCAN(
        eps=float(eps),
        min_samples=min_samples,
        algorithm="kd_tree",
        n_jobs=-1,
    )
    labels = dbscan.fit_predict(scaled)
    return labels.astype(int)


def _prepare_reduction_inputs(
    config: ScatterplotConfig, emit_progress: Callable[[int, str], None]
) -> PreparedReductionInputs:
    """Preps matrix and metadata for reduction algorithms."""

    from app.services import metadata, visibility

    project_name, array_entry = _resolve_dataset(config.dataset_id)
    array = array_entry["array"]

    if array.ndim == 0:
        row_count = 1
    else:
        row_count = int(array.shape[0]) if array.shape else 0

    if row_count <= 0:
        raise ScatterDataError("Dataset does not contain any rows")

    reshaped = array.reshape(row_count, -1)
    column_count = int(reshaped.shape[1]) if reshaped.ndim == 2 else 1

    emit_progress(5, "Resolving dataset columns…")

    # Compute subject mapping for multi-subject arrays (before filtering)
    subject_mapping: Optional[Dict[str, List[int]]] = None
    if config.multi_subject and column_count >= 1 and not config.subject_id:
        subject_mapping = _compute_subject_mapping(reshaped)

    if config.subject_id and config.multi_subject and column_count >= 1:
        reshaped, row_count = _filter_subject_rows(reshaped, config.subject_id)
        if row_count <= 0:
            raise ScatterDataError("No rows available for the selected subject")

    default_columns = [f"Column {index + 1}" for index in range(column_count)] or ["Value"]
    custom_names = visibility.array_column_names(project_name, array_entry["id"])
    resolved_columns = metadata.apply_column_names(default_columns, custom_names)

    emit_progress(10, "Normalizing selected columns…")

    normalized_identifiers = _normalize_column_identifiers(config.columns)
    selected_indices = _resolve_column_indices(normalized_identifiers, resolved_columns)

    if len(selected_indices) < 2:
        raise ScatterDataError("Dimensionality reduction requires at least two columns")

    emit_progress(20, "Building numeric matrix for reduction…")
    matrix = _build_numeric_matrix(reshaped, selected_indices)

    row_total = int(matrix.shape[0]) if matrix.ndim == 2 else int(matrix.size > 0)
    if row_total <= 1:
        raise ScatterDataError("Dimensionality reduction requires multiple rows")

    target_dimension = min(config.dimension, matrix.shape[1])
    if target_dimension < 1:
        raise ScatterDataError("Target dimensionality is invalid for dimensionality reduction")

    subject_payload: Optional[Dict[str, str]] = None
    if config.subject_id:
        subject_label = config.subject_label or config.subject_id
        subject_payload = {"id": config.subject_id, "label": subject_label}

    row_indices = list(range(row_total))

    return PreparedReductionInputs(
        matrix=matrix,
        target_dimension=target_dimension,
        subject_payload=subject_payload,
        row_indices=row_indices,
        subject_mapping=subject_mapping,
    )


async def build_reduced_scatter_data(
    config: ScatterplotConfig, job_id: Optional[str] = None, n_neighbors: Optional[int] = None
) -> ScatterplotData:
    """Perform dimensionality reduction to generate scatter plot coordinates.
    
    Args:
        config: Scatter plot configuration
        job_id: Optional job ID for progress tracking
        n_neighbors: Optional number of neighbors for UMAP (default: 15)
    """

    method = (config.reduction or "").lower()
    method_label = method.upper() if method else "Dimensionality"

    if job_id:
        from app.services import progress as progress_service

        def emit_progress(percentage: int, message: str, *, status: str = "running") -> None:
            try:
                progress_service.update_progress(job_id, percentage, message, status=status)
            except Exception:  # pragma: no cover - defensive logging only
                LOGGER.debug("Failed to record scatter reduction progress", exc_info=True)

        def schedule_progress_cleanup(delay: float = 5.0) -> None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:  # pragma: no cover - defensive fallback
                progress_service.clear_progress(job_id)
                return
            loop.call_later(delay, progress_service.clear_progress, job_id)

    else:

        def emit_progress(*args, **kwargs) -> None:
            return

        def schedule_progress_cleanup(*args, **kwargs) -> None:
            return

    emit_progress(1, f"Preparing data for {method_label} reduction…")
    cleanup_delay: Optional[float] = None

    try:
        prepared = _prepare_reduction_inputs(config, emit_progress)

        reducer = _REDUCTION_METHODS.get(method)
        if reducer is None:
            raise ScatterDataError(f"Unsupported dimensionality reduction method: {config.reduction!r}")

        emit_progress(25, f"Dispatching {method_label} reducer…")

        def reducer_callback(percentage: int, message: str) -> None:
            emit_progress(percentage, message)

        # For PCA: get metadata + up to 10 components for axis remapping
        return_metadata = method == "pca"
        
        try:
            if return_metadata:
                # Compute up to 10 components
                metadata_components = min(10, prepared.matrix.shape[1])
                metadata_result = await asyncio.to_thread(
                    reducer,
                    prepared.matrix,
                    metadata_components,
                    progress_callback=reducer_callback,
                    return_metadata=True,
                )
                full_projection = metadata_result["coordinates"]
                # Use only target dims (2 or 3) for display
                reduced = full_projection[:, :prepared.target_dimension]
                
                pca_meta = {
                    "explained_variance": metadata_result["explained_variance"],
                    "total_variance": metadata_result["total_variance"],
                    "components_count": metadata_result["components_count"],
                    "full_projection_dimensions": full_projection.shape[1],
                    # Full projection for axis remapping
                    "full_projection": full_projection.tolist(),
                }
            else:
                # Pass n_neighbors for UMAP if set
                reducer_kwargs = {
                    "progress_callback": reducer_callback,
                    "return_metadata": False,
                }
                if method == "umap" and n_neighbors is not None:
                    reducer_kwargs["n_neighbors"] = n_neighbors
                    
                reduction_result = await asyncio.to_thread(
                    reducer,
                    prepared.matrix,
                    prepared.target_dimension,
                    **reducer_kwargs,
                )
                reduced = reduction_result
                pca_meta = None
        except ValueError as exc:
            raise ScatterDataError(str(exc) or "Dimensionality reduction failed") from exc

        metadata_builder = _COMPONENT_METADATA_BUILDERS.get(method)
        if metadata_builder is None:
            raise ScatterDataError(f"No metadata builder registered for {method!r}")

        column_metadata = [
            ScatterplotColumn(key=key, label=label, column_index=index + 1)
            for index, (key, label) in enumerate(metadata_builder(reduced.shape[1]))
        ]

        emit_progress(90, "Formatting scatter plot coordinates…")
        points: List[ScatterplotPoint] = []
        for index, row_index in enumerate(prepared.row_indices):
            coordinates = [float(value) for value in reduced[index]]
            points.append(ScatterplotPoint(row_index=row_index, coordinates=coordinates))

        emit_progress(95, "Preparing scatter plot response…")
        cleanup_delay = 5.0
        emit_progress(100, f"{method_label} reduction complete", status="completed")

        return ScatterplotData(
            dimension=prepared.target_dimension,
            points=points,
            columns=column_metadata,
            subject=prepared.subject_payload,
            pca_metadata=pca_meta,
            subject_mapping=prepared.subject_mapping,
        )
    except ScatterDataError:
        cleanup_delay = 30.0
        emit_progress(100, f"{method_label} reduction failed", status="error")
        raise
    finally:
        if cleanup_delay is not None:
            schedule_progress_cleanup(cleanup_delay)


async def start_tsne_session(
    config: ScatterplotConfig,
    *,
    project_name: str,
    sheet_id: str,
    card_id: str,
    job_id: Optional[str] = None,
    iterations: Optional[int] = None,
    perplexity: Optional[float] = None,
    learning_rate: Optional[float] = None,
) -> Dict[str, object]:
    """Start a live t-SNE session and return the initial scatter payload."""

    method_label = "t-SNE"

    if job_id:
        from app.services import progress as progress_service

        def emit_progress(percentage: int, message: str, *, status: str = "running") -> None:
            try:
                progress_service.update_progress(job_id, percentage, message, status=status)
            except Exception:  # pragma: no cover - defensive logging only
                LOGGER.debug("Failed to record t-SNE progress", exc_info=True)

        def schedule_progress_cleanup(delay: float = 5.0) -> None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:  # pragma: no cover
                progress_service.clear_progress(job_id)
                return
            loop.call_later(delay, progress_service.clear_progress, job_id)

    else:

        def emit_progress(*args, **kwargs) -> None:
            return

        def schedule_progress_cleanup(*args, **kwargs) -> None:
            return

    emit_progress(1, f"Preparing data for {method_label} session…")
    cleanup_delay: Optional[float] = None

    _maybe_cleanup_tsne_sessions()

    try:
        prepared = _prepare_reduction_inputs(config, emit_progress)

        metadata_builder = _COMPONENT_METADATA_BUILDERS.get("tsne")
        if metadata_builder is None:
            raise ScatterDataError("t-SNE metadata builder is unavailable")

        column_metadata = [
            ScatterplotColumn(key=key, label=label, column_index=index + 1)
            for index, (key, label) in enumerate(metadata_builder(prepared.target_dimension))
        ]

        emit_progress(20, "Initializing t-SNE layout…")
        try:
            initial_embedding = await asyncio.to_thread(
                pca.reduce,
                prepared.matrix,
                prepared.target_dimension,
                progress_callback=None,
            )
        except Exception:
            try:
                initial_embedding = prepared.matrix[:, : prepared.target_dimension]
            except Exception as exc:
                raise ScatterDataError("Failed to initialize t-SNE embedding") from exc

        emit_progress(35, "Launching t-SNE optimizer…")

        try:
            session = tsne_reduction.start_session(
                prepared.matrix,
                prepared.target_dimension,
                iterations=int(iterations or tsne_reduction.DEFAULT_MAX_ITERATIONS),
                perplexity=float(perplexity or tsne_reduction.DEFAULT_PERPLEXITY),
                learning_rate=float(learning_rate or tsne_reduction.DEFAULT_LEARNING_RATE),
                initial_embedding=initial_embedding,
            )
        except (ValueError, tsne_reduction.TsneUnavailableError) as exc:
            raise ScatterDataError(str(exc) or "t-SNE session could not be started") from exc

        context = ScatterTsneContext(
            session_id=session.id,
            project_name=project_name,
            sheet_id=sheet_id,
            card_id=card_id,
            columns=column_metadata,
            column_labels=list(config.column_labels),
            subject=prepared.subject_payload,
            dimension=prepared.target_dimension,
            row_indices=prepared.row_indices,
        )
        _TSNE_SESSIONS[session.id] = context
        context.updated_at = time.monotonic()

        point_objects = _build_points_from_embedding(initial_embedding, prepared.row_indices)
        emit_progress(50, "t-SNE session running…")

        payload: Dict[str, object] = {
            "status": "tsne_live",
            "method": "tsne",
            "sessionId": session.id,
            "state": "running",
            "iteration": 0,
            "maxIterations": session.max_iterations,
            "dimension": prepared.target_dimension,
            "points": [
                {"rowIndex": point.row_index, "coordinates": point.coordinates}
                for point in point_objects
            ],
            "columns": [
                {
                    "key": column.key,
                    "label": column.label,
                    "columnIndex": column.column_index,
                }
                for column in column_metadata
            ],
        }

        if prepared.subject_payload:
            payload["subject"] = prepared.subject_payload
        if prepared.subject_mapping:
            payload["subjectMapping"] = prepared.subject_mapping
        if context.column_labels:
            payload["columnLabels"] = context.column_labels

        cleanup_delay = 5.0
        emit_progress(100, "t-SNE live session initialized", status="completed")
        return payload
    finally:
        if cleanup_delay is not None:
            schedule_progress_cleanup(cleanup_delay)


def get_tsne_session_state(
    session_id: str,
    *,
    project_name: str,
    sheet_id: str,
    card_id: str,
    since_iteration: Optional[int] = None,
) -> Dict[str, object]:
    """Gets latest live t-SNE state."""

    _maybe_cleanup_tsne_sessions()

    context = _TSNE_SESSIONS.get(session_id)
    if (
        context is None
        or context.project_name != project_name
        or context.sheet_id != sheet_id
        or context.card_id != card_id
    ):
        raise ScatterDataError("t-SNE session is not available for this card")

    context.updated_at = time.monotonic()

    session = tsne_reduction.get_session(session_id)
    if session is None:
        _cleanup_tsne_session(session_id)
        raise ScatterDataError("t-SNE session has finished")

    snapshot = session.snapshot()
    include_points = True
    if since_iteration is not None and snapshot.iteration <= int(since_iteration):
        include_points = False

    payload: Dict[str, object] = {
        "sessionId": session_id,
        "state": snapshot.state,
        "iteration": snapshot.iteration,
        "maxIterations": session.max_iterations,
        "dimension": context.dimension,
    }

    if include_points and snapshot.embedding is not None:
        point_objects = _build_points_from_embedding(snapshot.embedding, context.row_indices)
        payload["points"] = [
            {"rowIndex": point.row_index, "coordinates": point.coordinates}
            for point in point_objects
        ]

    if snapshot.error:
        payload["message"] = snapshot.error
    if context.subject:
        payload["subject"] = context.subject
    if context.column_labels:
        payload["columnLabels"] = context.column_labels

    if snapshot.state in {"completed", "stopped", "error"}:
        _cleanup_tsne_session(session_id)

    return payload


def control_tsne_session(
    session_id: str,
    *,
    project_name: str,
    sheet_id: str,
    card_id: str,
    action: str,
) -> Dict[str, object]:
    """Apply a control command to a live t-SNE session."""

    _maybe_cleanup_tsne_sessions()

    context = _TSNE_SESSIONS.get(session_id)
    if (
        context is None
        or context.project_name != project_name
        or context.sheet_id != sheet_id
        or context.card_id != card_id
    ):
        raise ScatterDataError("t-SNE session is not available for this card")

    context.updated_at = time.monotonic()

    session = tsne_reduction.get_session(session_id)
    if session is None:
        _cleanup_tsne_session(session_id)
        raise ScatterDataError("t-SNE session has finished")

    normalized = (action or "").strip().lower()
    if normalized == "stop":
        session.stop()
    else:
        raise ScatterDataError("Unsupported t-SNE control action")

    snapshot = session.snapshot()
    if snapshot.state in {"completed", "stopped", "error"}:
        _cleanup_tsne_session(session_id)

    return {
        "sessionId": session_id,
        "state": snapshot.state,
        "iteration": snapshot.iteration,
        "maxIterations": session.max_iterations,
    }


def _cleanup_tsne_session(session_id: Optional[str]) -> None:
    if not session_id:
        return
    _TSNE_SESSIONS.pop(session_id, None)
    tsne_reduction.remove_session(session_id)


def _maybe_cleanup_tsne_sessions() -> None:
    """Opportunistically prune idle live t-SNE sessions."""

    global _LAST_TSNE_CLEANUP
    now = time.monotonic()
    if now - _LAST_TSNE_CLEANUP < _TSNE_CLEANUP_INTERVAL:
        return

    _LAST_TSNE_CLEANUP = now
    expired: List[str] = []
    for session_id, context in list(_TSNE_SESSIONS.items()):
        if now - context.updated_at >= _TSNE_SESSION_TTL:
            expired.append(session_id)

    for session_id in expired:
        LOGGER.info("Cleaning up idle t-SNE session %s", session_id)
        _cleanup_tsne_session(session_id)


def _build_points_from_embedding(
    embedding: np.ndarray, row_indices: Sequence[int]
) -> List[ScatterplotPoint]:
    if embedding is None:
        return []
    values = np.asarray(embedding)
    if values.ndim != 2:
        return []
    count = min(len(row_indices), values.shape[0])
    points: List[ScatterplotPoint] = []
    for index in range(count):
        coordinates = [float(value) for value in values[index]]
        points.append(
            ScatterplotPoint(row_index=int(row_indices[index]), coordinates=coordinates)
        )
    return points


def _parse_columns(value: object) -> List[str]:
    if not isinstance(value, Iterable):
        return []

    columns: List[str] = []
    for entry in value:
        column_id: Optional[str]
        if isinstance(entry, Mapping):
            raw_identifier = entry.get("id") or entry.get("column")
            column_id = _parse_optional_string(raw_identifier)
        else:
            column_id = _parse_optional_string(entry)
        if column_id:
            columns.append(column_id)
    return columns


def _parse_dimension(value: object) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    text = _parse_optional_string(value)
    if text is None:
        return 0
    try:
        return int(text)
    except (TypeError, ValueError):
        return 0


def _parse_reduction(value: object) -> Optional[str]:
    text = _parse_optional_string(value)
    if text is None:
        return None
    lowered = text.lower()
    return lowered if lowered in _ALLOWED_REDUCTIONS else None


def _parse_optional_string(value: object) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        text = str(value).strip()
    except Exception:
        return None
    return text or None


def _parse_column_labels(value: object) -> List[str]:
    if not isinstance(value, Iterable):
        return []
    labels: List[str] = []
    for entry in value:
        label = _parse_optional_string(entry)
        if label:
            labels.append(label)
    return labels


def _resolve_dataset(dataset_id: str) -> Tuple[str, Mapping[str, object]]:
    from app.services import registry
    from app.storage import project_storage

    if not isinstance(dataset_id, str):
        raise ScatterDataError("Dataset identifier must be a string")

    normalized = dataset_id.strip()
    if not normalized or _DATASET_DELIMITER not in normalized:
        raise ScatterDataError("Dataset identifier is invalid")

    project_name, array_selector = normalized.split(_DATASET_DELIMITER, 1)
    project_name = project_name.strip()
    array_selector = array_selector.strip()

    if not project_name or not array_selector:
        raise ScatterDataError("Dataset identifier must include project and array")

    arrays = registry.get_project(project_name)
    if arrays is None and not registry.load_project_from_disk(project_name):
        raise ScatterDataError("Project could not be loaded")

    arrays = registry.get_project(project_name)
    if arrays is None:
        raise ScatterDataError("Project is not available")

    manifest = project_storage.ensure_project_manifest(project_name, arrays)
    entry = project_storage.find_array_entry_by_id(manifest, array_selector)
    if entry is None:
        entry = project_storage.find_array_entry_by_name(manifest, array_selector)
    if entry is None:
        raise ScatterDataError("Array not found in project")

    array_name = entry.get("name") or ""
    if array_name not in arrays:
        raise ScatterDataError("Dataset array could not be located")

    return project_name, {"id": entry.get("id"), "array": arrays[array_name]}


def _filter_subject_rows(array: np.ndarray, subject_id: str) -> Tuple[np.ndarray, int]:
    column = array[:, 0]
    try:
        if np.issubdtype(column.dtype, np.number):
            target = float(subject_id)
            if np.issubdtype(column.dtype, np.integer):
                target = int(round(target))
            mask = column == target
        else:
            mask = column.astype("U") == str(subject_id)
    except Exception:
        mask = column.astype("U") == str(subject_id)

    filtered = array[mask]
    row_count = int(filtered.shape[0]) if filtered.ndim == 2 else int(filtered.size > 0)
    return filtered, row_count


def _compute_subject_mapping(array: np.ndarray) -> Dict[str, List[int]]:
    """Compute row ranges for each subject in a multi-subject array.
    
    Returns a dictionary mapping subject IDs to [start_row, end_row] ranges.
    The first column of the array is expected to contain subject IDs.
    """
    if array.ndim != 2 or array.shape[0] == 0 or array.shape[1] == 0:
        return {}
    
    column = array[:, 0]
    mapping: Dict[str, List[int]] = {}
    
    # Track first/last occurrence per subject
    subject_first: Dict[str, int] = {}
    subject_last: Dict[str, int] = {}
    
    for row_idx in range(len(column)):
        value = column[row_idx]
        
        # Convert to string representation
        try:
            if np.issubdtype(column.dtype, np.number):
                if np.issubdtype(column.dtype, np.integer):
                    subject_id = str(int(value))
                else:
                    subject_id = str(float(value))
            else:
                subject_id = str(value)
        except Exception:
            subject_id = str(value)
        
        if subject_id not in subject_first:
            subject_first[subject_id] = row_idx
        subject_last[subject_id] = row_idx
    
    # Build the mapping with [start, end] ranges
    for subject_id in subject_first:
        mapping[subject_id] = [subject_first[subject_id], subject_last[subject_id]]
    
    return mapping


def _normalize_column_identifiers(columns: Sequence[str]) -> List[str]:
    identifiers: List[str] = []
    for entry in columns:
        if not isinstance(entry, str):
            continue
        text = entry.strip()
        if text:
            identifiers.append(text)
    return identifiers


def _resolve_column_indices(identifiers: Sequence[str], labels: Sequence[str]) -> List[int]:
    indices: List[int] = []
    seen: set[int] = set()
    for identifier in identifiers:
        index = _parse_column_index(identifier)
        if index is None:
            index = _match_column_label(identifier, labels)
        if index in seen or index is None:
            continue
        indices.append(index)
        seen.add(index)
    return indices


def _parse_column_index(identifier: str) -> Optional[int]:
    try:
        value = int(identifier)
    except (TypeError, ValueError):
        match = _COLUMN_PATTERN.match(identifier)
        if match:
            value = int(match.group("index"))
        else:
            return None

    if value < 1:
        raise ScatterDataError("Column index must be positive")
    return value - 1


def _match_column_label(identifier: str, labels: Sequence[str]) -> int:
    normalized = identifier.lower()
    for index, label in enumerate(labels):
        label_text = str(label or "").strip()
        if not label_text:
            continue
        if normalized == label_text.lower():
            return index
    raise ScatterDataError(f"Column {identifier!r} not found")


def _normalize_column_values(values: np.ndarray) -> List[object]:
    normalized: List[object] = []
    for value in values:
        normalized.append(_normalize_value(value))
    return normalized


def _build_numeric_matrix(array: np.ndarray, indices: Sequence[int]) -> np.ndarray:
    columns: List[List[float]] = []
    for index in indices:
        normalized = _normalize_column_values(array[:, index])
        numeric_column: List[float] = []
        for value in normalized:
            try:
                number = float(value)
            except (TypeError, ValueError):
                raise ScatterDataError(
                    "Dimensionality reduction requires numeric column values"
                ) from None
            if not math.isfinite(number):
                raise ScatterDataError(
                    "Dimensionality reduction requires finite numeric values"
                )
            numeric_column.append(number)
        columns.append(numeric_column)

    matrix = np.array(columns, dtype=float).T
    if matrix.ndim != 2:
        raise ScatterDataError("Unable to construct numeric matrix for dimensionality reduction")
    return matrix


def _normalize_value(value: object) -> object:
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


__all__ = [
    "ScatterConfigurationError",
    "ScatterDataError",
    "ScatterplotConfig",
    "ScatterplotData",
    "ScatterPrecomputeResult",
    "build_direct_scatter_data",
    "parse_card_configuration",
    "prepare_precompute_job",
]

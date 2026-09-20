"""PCA dimensionality reduction for scatter plot visualization."""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

import numpy as np

LOGGER = logging.getLogger(__name__)


def prepare(
    *,
    project: str,
    dataset: str,
    sheet_id: str,
    card_id: str,
    columns: Iterable[str],
    dimension: int,
    subject: Optional[str] = None,
    multi_subject: bool = False,
) -> Dict[str, Any]:
    """Schedule a PCA reduction job for a scatter plot card."""

    column_list = list(columns)
    LOGGER.info(
        "Scheduling PCA reduction",
        extra={
            "project": project,
            "dataset": dataset,
            "sheet_id": sheet_id,
            "card_id": card_id,
            "columns": column_list,
            "dimension": dimension,
            "subject": subject,
            "multi_subject": multi_subject,
        },
    )

    job_identifier = f"pca::{project}::{sheet_id}::{card_id}"
    return {
        "jobId": job_identifier,
        "status": "ready",
        "method": "pca",
        "columns": column_list,
        "dimension": dimension,
        "message": "PCA reduction will be computed on demand.",
    }


def reduce(
    matrix: np.ndarray,
    target_dimension: int,
    *,
    progress_callback: Optional[Callable[[int, str], None]] = None,
    return_metadata: bool = False,
) -> np.ndarray | Dict[str, Any]:
    """Apply PCA to reduce high-dimensional data to a lower-dimensional space.
    
    Args:
        matrix: Input data matrix with shape (n_samples, n_features)
        target_dimension: Number of principal components to retain
        progress_callback: Optional function to report progress
        return_metadata: If True, return dict with coordinates and variance info
        
    Returns:
        If return_metadata is False: array of projected coordinates
        If return_metadata is True: dict containing coordinates, explained variance,
            total variance, and component count
    """

    def emit_progress(percentage: int, message: str) -> None:
        if progress_callback is None:
            return
        try:
            progress_callback(int(percentage), str(message))
        except Exception:
            LOGGER.debug("PCA progress callback failed", exc_info=True)

    if matrix.ndim != 2:
        raise ValueError("Input matrix must be two-dimensional")

    rows, columns = matrix.shape
    if rows <= 1 or columns <= 0:
        raise ValueError("Input matrix must contain multiple rows and columns")

    dimension = min(max(1, int(target_dimension)), min(rows, columns))

    emit_progress(5, "Initializing PCA reduction")
    centered = matrix - np.mean(matrix, axis=0, keepdims=True)
    emit_progress(15, "Centering data for PCA")

    try:
        emit_progress(35, "Starting singular value decomposition")
        _, singular_values, vh = np.linalg.svd(centered, full_matrices=False)
    except np.linalg.LinAlgError as exc:
        emit_progress(70, "PCA decomposition failed")
        raise ValueError("PCA decomposition failed") from exc

    emit_progress(70, "SVD completed, projecting data")
    components = vh[:dimension]
    emit_progress(85, "Computing principal component projection")
    result = np.dot(centered, components.T)
    emit_progress(100, "PCA reduction complete")

    if not return_metadata:
        return result

    # Get variance ratios per component
    total_variance = np.sum(singular_values**2)
    explained_variance_ratios = []
    if total_variance > 0:
        for i in range(dimension):
            component_variance = singular_values[i]**2
            ratio = float(component_variance / total_variance)
            explained_variance_ratios.append(ratio)
    else:
        explained_variance_ratios = [0.0] * dimension

    total_explained = sum(explained_variance_ratios)

    return {
        "coordinates": result,
        "explained_variance": explained_variance_ratios,
        "total_variance": total_explained,
        "components_count": dimension,
    }


def component_metadata(dimension: int) -> List[Tuple[str, str]]:
    """Component column names for PCA."""

    dimension = max(1, int(dimension))
    return [(f"pc_{index + 1}", f"PC {index + 1}") for index in range(dimension)]


__all__ = ["component_metadata", "prepare", "reduce"]

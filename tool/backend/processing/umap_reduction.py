"""UMAP dimensionality reduction for scatter plot visualization."""

from __future__ import annotations

import contextlib
import logging
import re
import sys
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

import numpy as np

try:
    import umap  # type: ignore
except Exception:
    umap = None

LOGGER = logging.getLogger(__name__)

DEFAULT_NEIGHBORS = 15


class UmapProgressCapture:
    """Captures UMAP verbose output and converts it to progress updates."""

    def __init__(self, emit_progress: Callable[[int, str], None]):
        self.emit_progress = emit_progress
        self.buf = ""
        self.epoch_pattern = re.compile(r"completed\s+(\d+)\s+/\s+(\d+)\s+epochs")
        self.emitting = False

    def write(self, text: str) -> None:
        if self.emitting:
            return
        self.buf += text
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            self.process_line(line)

    def flush(self) -> None:
        if self.buf:
            self.process_line(self.buf)
            self.buf = ""

    def process_line(self, line: str) -> None:
        if "Construct fuzzy simplicial set" in line:
            self._safe_emit(30, "Building nearest neighbor graph")
        elif "Finding Nearest Neighbors" in line:
            self._safe_emit(35, "Finding nearest neighbors")
        elif "Finished Nearest Neighbor Search" in line:
            self._safe_emit(45, "Nearest neighbor search complete")
        elif "Construct embedding" in line:
            self._safe_emit(50, "Initializing embedding")

        match = self.epoch_pattern.search(line)
        if match:
            current, total = map(int, match.groups())
            if total > 0:
                progress = 50 + int((current / total) * 35)
                self._safe_emit(progress, f"Optimizing layout: epoch {current}/{total}")

    def _safe_emit(self, percentage: int, message: str) -> None:
        self.emitting = True
        try:
            self.emit_progress(percentage, message)
        finally:
            self.emitting = False


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
    """Register a UMAP reduction job request."""

    column_list = list(columns)
    LOGGER.info(
        "Scheduling UMAP reduction",
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

    job_identifier = f"umap::{project}::{sheet_id}::{card_id}"
    return {
        "jobId": job_identifier,
        "status": "ready",
        "method": "umap",
        "columns": column_list,
        "dimension": dimension,
        "message": "UMAP reduction will be computed on demand.",
    }


def reduce(
    matrix: np.ndarray,
    target_dimension: int,
    *,
    n_neighbors: int = DEFAULT_NEIGHBORS,
    progress_callback: Optional[Callable[[int, str], None]] = None,
    return_metadata: bool = False,
) -> np.ndarray:
    """Apply UMAP reduction to transform high-dimensional data to lower dimensions.
    
    Args:
        matrix: Input data matrix with shape (n_samples, n_features)
        target_dimension: Number of dimensions in the output
        n_neighbors: Number of neighbors for manifold approximation
        progress_callback: Function to call with progress updates
        return_metadata: API compatibility parameter (ignored for UMAP)
    
    Returns:
        Reduced coordinates as numpy array with shape (n_samples, target_dimension)
    """

    def emit_progress(percentage: int, message: str) -> None:
        if progress_callback is None:
            return
        try:
            progress_callback(int(percentage), str(message))
        except Exception:
            LOGGER.debug("UMAP progress callback failed", exc_info=True)

    if umap is None:
        raise ValueError("UMAP dependency is not available")

    if matrix.ndim != 2:
        raise ValueError("Input matrix must be two-dimensional")

    rows, columns = matrix.shape
    if rows <= 1 or columns <= 0:
        raise ValueError("Input matrix must contain multiple rows and columns")

    dimension = min(max(1, int(target_dimension)), max(1, columns))
    emit_progress(25, "Initializing UMAP reduction")

    try:
        reducer = umap.UMAP(n_components=dimension, n_neighbors=int(n_neighbors), verbose=True)
        
        capture = UmapProgressCapture(emit_progress)
        with contextlib.redirect_stdout(capture):
            embedding = reducer.fit_transform(matrix)
            
    except Exception as exc:
        emit_progress(85, "UMAP optimization failed")
        raise ValueError("UMAP decomposition failed") from exc
    
    emit_progress(85, "Low dimensional layout optimized")

    if not isinstance(embedding, np.ndarray):
        embedding = np.asarray(embedding)

    if embedding.ndim != 2:
        raise ValueError("UMAP returned an unexpected result shape")

    emit_progress(88, "Finalizing embedding")
    emit_progress(88, "Preparing scatter plot coordinates")
    emit_progress(90, "UMAP reduction complete")

    return embedding


def component_metadata(dimension: int) -> List[Tuple[str, str]]:
    """Component column names for UMAP."""

    dimension = max(1, int(dimension))
    return [(f"umap_{index + 1}", f"UMAP {index + 1}") for index in range(dimension)]


__all__ = ["component_metadata", "prepare", "reduce"]


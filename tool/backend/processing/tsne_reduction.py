"""Iterative t-SNE dimensionality reduction for scatter plot visualization."""

from __future__ import annotations

import inspect
import logging
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Dict, Optional

import numpy as np

try:
    from sklearn.manifold import TSNE
except Exception:
    TSNE = None

try:
    from sklearn.manifold import _t_sne as _sklearn_tsne_internal
except Exception:
    _sklearn_tsne_internal = None

if TSNE is not None:
    try:
        _TSNE_SUPPORTS_SQUARE_DISTANCES = "square_distances" in inspect.signature(TSNE.__init__).parameters
    except Exception:
        _TSNE_SUPPORTS_SQUARE_DISTANCES = False
else:
    _TSNE_SUPPORTS_SQUARE_DISTANCES = False

LOGGER = logging.getLogger(__name__)

DEFAULT_MAX_ITERATIONS = 750
DEFAULT_PERPLEXITY = 30.0
DEFAULT_LEARNING_RATE = 200.0
DEFAULT_CHUNK_SIZE = 25

ProgressHandler = Callable[[int, np.ndarray], None]

_TSNE_PROGRESS_STATE = threading.local()
_TSNE_PATCHED = False
_ORIGINAL_GRADIENT_DESCENT = None


def _install_tsne_progress_patch() -> None:
    """Monkey-patch sklearn's gradient descent to emit progress updates during optimization."""

    global _TSNE_PATCHED, _ORIGINAL_GRADIENT_DESCENT

    if _TSNE_PATCHED or _sklearn_tsne_internal is None:
        return

    original = getattr(_sklearn_tsne_internal, "_gradient_descent", None)
    if original is None:
        return

    _ORIGINAL_GRADIENT_DESCENT = original

    def _gradient_descent_wrapper(objective, p0, it, max_iter, **kwargs):
        handler = getattr(_TSNE_PROGRESS_STATE, "handler", None)
        if handler is None:
            return original(objective, p0, it, max_iter, **kwargs)
        return _gradient_descent_with_progress(handler, objective, p0, it, max_iter, **kwargs)

    _sklearn_tsne_internal._gradient_descent = _gradient_descent_wrapper
    _TSNE_PATCHED = True


def _gradient_descent_with_progress(
    handler: ProgressHandler,
    objective,
    p0,
    it,
    max_iter,
    *,
    n_iter_check=1,
    n_iter_without_progress=300,
    momentum=0.8,
    learning_rate=200.0,
    min_gain=0.01,
    min_grad_norm=1e-7,
    verbose=0,
    args=None,
    kwargs=None,
):
    if args is None:
        args = []
    if kwargs is None:
        kwargs = {}

    p = p0.copy().ravel()
    update = np.zeros_like(p)
    gains = np.ones_like(p)
    error = np.finfo(float).max
    best_error = np.finfo(float).max
    best_iter = i = it
    tic = time.perf_counter()

    n_samples = None
    n_components = None
    if len(args) >= 4:
        try:
            n_samples = int(args[2])
            n_components = int(args[3])
        except Exception:
            n_samples = None
            n_components = None

    for i in range(it, max_iter):
        check_convergence = (i + 1) % n_iter_check == 0
        kwargs["compute_error"] = check_convergence or i == max_iter - 1

        error, grad = objective(p, *args, **kwargs)

        inc = update * grad < 0.0
        dec = np.invert(inc)
        gains[inc] += 0.2
        gains[dec] *= 0.8
        np.clip(gains, min_gain, np.inf, out=gains)
        grad *= gains
        update = momentum * update - learning_rate * grad
        p += update

        if handler and n_samples and n_components:
            try:
                embedding = p.reshape(n_samples, n_components).copy()
                handler(i + 1, embedding)
            except Exception:
                LOGGER.debug("t-SNE progress handler failed", exc_info=True)

        if check_convergence:
            toc = time.perf_counter()
            duration = toc - tic
            tic = toc
            grad_norm = float(np.linalg.norm(grad))

            if verbose >= 2:
                print(
                    "[t-SNE] Iteration %d: error = %.7f," " gradient norm = %.7f" " (%s iterations in %0.3fs)"
                    % (i + 1, error, grad_norm, n_iter_check, duration)
                )

            if error < best_error:
                best_error = error
                best_iter = i
            elif i - best_iter > n_iter_without_progress:
                if verbose >= 2:
                    print(
                        "[t-SNE] Iteration %d: did not make any progress "
                        "during the last %d episodes. Finished."
                        % (i + 1, n_iter_without_progress)
                    )
                break
            if grad_norm <= min_grad_norm:
                if verbose >= 2:
                    print(
                        "[t-SNE] Iteration %d: gradient norm %f. Finished."
                        % (i + 1, grad_norm)
                    )
                break

    return p, error, i


@contextmanager
def _tsne_progress_listener(handler: Optional[ProgressHandler]):
    if not _TSNE_PATCHED or handler is None:
        yield
        return

    previous = getattr(_TSNE_PROGRESS_STATE, "handler", None)
    _TSNE_PROGRESS_STATE.handler = handler
    try:
        yield
    finally:
        if previous is None:
            if hasattr(_TSNE_PROGRESS_STATE, "handler"):
                delattr(_TSNE_PROGRESS_STATE, "handler")
        else:
            _TSNE_PROGRESS_STATE.handler = previous


class TsneUnavailableError(RuntimeError):
    """scikit-learn not installed."""


@dataclass
class TsneSnapshot:
    """Lightweight snapshot of the current optimization state."""

    iteration: int
    state: str
    embedding: Optional[np.ndarray]
    error: Optional[str]


class TsneSession:
    """Background worker executing iterative t-SNE optimization."""

    def __init__(
        self,
        matrix: np.ndarray,
        target_dimension: int,
        *,
        max_iterations: int,
        perplexity: float,
        learning_rate: float,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        initial_embedding: Optional[np.ndarray] = None,
    ) -> None:
        if matrix.ndim != 2:
            raise ValueError("Input matrix must be two-dimensional for t-SNE")
        if matrix.shape[0] <= 1 or matrix.shape[1] <= 0:
            raise ValueError("Dataset must contain at least two rows and one column")
        if TSNE is None:
            raise TsneUnavailableError("scikit-learn dependency is not available for t-SNE")

        _install_tsne_progress_patch()

        self.id = uuid.uuid4().hex
        self.matrix = np.asarray(matrix, dtype=np.float64)
        self.target_dimension = max(1, int(target_dimension))
        self.max_iterations = max(10, int(max_iterations))
        self.chunk_size = max(1, int(chunk_size))

        max_perplexity = max(1.0, (self.matrix.shape[0] - 1) / 3.0)
        safe_perplexity = min(max(5.0, float(perplexity)), max_perplexity)
        self.perplexity = safe_perplexity
        self.learning_rate = float(learning_rate) if learning_rate and learning_rate > 0 else DEFAULT_LEARNING_RATE

        self.iteration = 0
        self.state = "running"
        self.error: Optional[str] = None
        self.created_at = time.monotonic()
        self.updated_at = self.created_at

        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._stop_requested = False
        self._thread = threading.Thread(target=self._run, name=f"tsne-session-{self.id[:8]}", daemon=True)

        if initial_embedding is not None:
            self.embedding = np.asarray(initial_embedding, dtype=np.float32)
        else:
            self.embedding = None

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:  # pragma: no cover - background thread
        try:
            embedding = None
            if self.embedding is not None:
                embedding = np.asarray(self.embedding, dtype=np.float64)
            else:
                # PCA init for stability
                embedding = self._initial_projection()
                self._set_embedding(0, embedding)

            completed = 0
            while completed < self.max_iterations:
                with self._condition:
                    if self._stop_requested or self.state == "stopped":
                        self.state = "stopped"
                        return

                # TSNE needs max_iter >= 250
                remaining = self.max_iterations - completed
                step = max(250, min(self.chunk_size, remaining))
                exaggeration = 12.0 if completed == 0 else 1.0
                tsne_kwargs = dict(
                    n_components=self.target_dimension,
                    perplexity=self.perplexity,
                    learning_rate=self.learning_rate,
                    max_iter=step,
                    n_iter_without_progress=max(50, step * 3),
                    metric="euclidean",
                    init=embedding,
                    random_state=42,
                    method="barnes_hut" if self.matrix.shape[0] > 250 else "exact",
                    angle=0.5,
                    early_exaggeration=exaggeration,
                    verbose=0,
                )
                if _TSNE_SUPPORTS_SQUARE_DISTANCES:
                    tsne_kwargs["square_distances"] = True

                handler = lambda iteration, coords, offset=completed: self._handle_iteration_progress(
                    offset, iteration, coords
                )
                tsne = TSNE(**tsne_kwargs)
                with _tsne_progress_listener(handler):
                    new_embedding = tsne.fit_transform(self.matrix)
                # Cap progress at max iterations
                completed = min(self.max_iterations, completed + step)
                embedding = np.asarray(new_embedding, dtype=np.float64)
                self._set_embedding(completed, embedding)

                if self._stop_requested:
                    with self._condition:
                        self.state = "stopped"
                    return

            with self._condition:
                if self.state != "stopped":
                    self.state = "completed"
        except Exception as exc:  # pragma: no cover - defensive
            LOGGER.exception("t-SNE optimization failed", exc_info=exc)
            with self._condition:
                self.state = "error"
                self.error = str(exc) or "t-SNE optimization failed"

    def _handle_iteration_progress(self, offset: int, iteration: int, embedding: np.ndarray) -> None:
        if self._stop_requested:
            return

        absolute_iteration = min(self.max_iterations, offset + int(iteration))
        if absolute_iteration <= self.iteration:
            return

        self._set_embedding(absolute_iteration, embedding)

    def _initial_projection(self) -> np.ndarray:
        # PCA init via SVD
        matrix = self.matrix - np.mean(self.matrix, axis=0, keepdims=True)
        try:
            _, _, vh = np.linalg.svd(matrix, full_matrices=False)
            components = vh[: self.target_dimension]
            projection = np.dot(matrix, components.T)
        except Exception:  # pragma: no cover - fallback path
            projection = matrix[:, : self.target_dimension]
        return projection.astype(np.float64)

    def _set_embedding(self, iteration: int, embedding: np.ndarray) -> None:
        with self._condition:
            self.iteration = int(iteration)
            self.embedding = np.asarray(embedding, dtype=np.float32)
            self.updated_at = time.monotonic()
            self._condition.notify_all()

    def snapshot(self) -> TsneSnapshot:
        with self._condition:
            embedding = None if self.embedding is None else np.array(self.embedding)
            return TsneSnapshot(
                iteration=int(self.iteration),
                state=str(self.state),
                embedding=embedding,
                error=self.error,
            )

    def stop(self) -> None:
        with self._condition:
            if self.state in {"completed", "error", "stopped"}:
                return
            self._stop_requested = True
            self.state = "stopped"
            self.updated_at = time.monotonic()
            self._condition.notify_all()


_SESSION_LOCK = threading.RLock()
_SESSION_STORE: Dict[str, TsneSession] = {}


def start_session(
    matrix: np.ndarray,
    target_dimension: int,
    *,
    iterations: int = DEFAULT_MAX_ITERATIONS,
    perplexity: float = DEFAULT_PERPLEXITY,
    learning_rate: float = DEFAULT_LEARNING_RATE,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    initial_embedding: Optional[np.ndarray] = None,
) -> TsneSession:
    """Start a new iterative t-SNE session and register it in the store."""

    session = TsneSession(
        matrix,
        target_dimension,
        max_iterations=iterations,
        perplexity=perplexity,
        learning_rate=learning_rate,
        chunk_size=chunk_size,
        initial_embedding=initial_embedding,
    )
    with _SESSION_LOCK:
        _SESSION_STORE[session.id] = session
    session.start()
    return session


def get_session(session_id: str) -> Optional[TsneSession]:
    """Lookup t-SNE session by ID."""

    if not session_id:
        return None
    with _SESSION_LOCK:
        return _SESSION_STORE.get(session_id)


def remove_session(session_id: str) -> None:
    """Remove a session from the registry."""

    if not session_id:
        return
    with _SESSION_LOCK:
        _SESSION_STORE.pop(session_id, None)


def component_metadata(dimension: int):
    """Component labels for t-SNE axes."""

    dimension = max(1, int(dimension))
    return [(f"tsne_{index + 1}", f"t-SNE {index + 1}") for index in range(dimension)]


__all__ = [
    "DEFAULT_LEARNING_RATE",
    "DEFAULT_MAX_ITERATIONS",
    "DEFAULT_PERPLEXITY",
    "DEFAULT_CHUNK_SIZE",
    "TsneSession",
    "TsneSnapshot",
    "TsneUnavailableError",
    "start_session",
    "get_session",
    "remove_session",
    "component_metadata",
]

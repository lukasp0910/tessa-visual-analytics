"""In-memory registry for uploaded projects."""

from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
from threading import Lock
from typing import Dict, Iterable, Mapping, Optional

import numpy as np

from app.storage import project_storage


class ProjectRegistry:
    """Thread-safe in-memory store that keeps uploaded projects available."""

    def __init__(self) -> None:
        self._projects: Dict[str, OrderedDict[str, np.ndarray]] = {}
        self._lock = Lock()

    def store(self, name: str, arrays: OrderedDict[str, np.ndarray]) -> None:
        with self._lock:
            self._projects[name] = arrays

    def get(self, name: str) -> Optional[OrderedDict[str, np.ndarray]]:
        with self._lock:
            return self._projects.get(name)

    def delete(self, name: str) -> bool:
        with self._lock:
            return self._projects.pop(name, None) is not None

    def rename(self, old_name: str, new_name: str) -> None:
        with self._lock:
            if old_name == new_name:
                return
            arrays = self._projects.pop(old_name, None)
            if arrays is None:
                return
            self._projects[new_name] = arrays


project_registry = ProjectRegistry()


def store_project(
    name: str,
    arrays: OrderedDict[str, np.ndarray],
    *,
    registry: ProjectRegistry = project_registry,
) -> None:
    """Store (or replace) the arrays for a project name."""

    safe_name = Path(name).name
    registry.store(safe_name, arrays)


def get_project(
    name: str,
    *,
    registry: ProjectRegistry = project_registry,
) -> Optional[OrderedDict[str, np.ndarray]]:
    """Gets project arrays from memory."""

    safe_name = Path(name).name
    return registry.get(safe_name)


def delete_project(
    name: str,
    *,
    registry: ProjectRegistry = project_registry,
) -> bool:
    """Remove a project from memory."""

    safe_name = Path(name).name
    return registry.delete(safe_name)


def rename_project(
    old_name: str,
    new_name: str,
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> str:
    """Rename a project both on disk and in memory."""

    safe_old = Path(old_name).name
    safe_new = Path(new_name).name

    if Path(safe_new).suffix.lower() != ".npz":
        raise ValueError("Project names must end with .npz")

    if safe_old == safe_new:
        if not storage.file_exists(safe_old) and registry.get(safe_old) is None:
            raise FileNotFoundError(f"Project {safe_old!r} not found")
        return safe_old

    storage.rename_file(safe_old, safe_new)
    registry.rename(safe_old, safe_new)
    return safe_new


def ensure_projects_available(
    names: Iterable[str],
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> None:
    """Ensure that the provided projects are loaded into memory."""

    for name in names:
        safe_name = Path(name).name
        load_project_from_disk(safe_name, registry=registry, storage=storage)


def load_project_from_disk(
    name: str,
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> bool:
    """Load a project from disk into memory if the underlying file exists."""

    safe_name = Path(name).name

    if registry.get(safe_name) is not None:
        return True

    file_path = storage.read_file_path(safe_name)
    if not file_path.exists():
        return False

    try:
        with np.load(file_path, allow_pickle=False) as npz_file:
            arrays = OrderedDict((key, np.array(npz_file[key])) for key in npz_file.files)
    except (OSError, ValueError, KeyError):
        return False

    registry.store(safe_name, arrays)
    return True


__all__ = [
    "ProjectRegistry",
    "project_registry",
    "store_project",
    "get_project",
    "delete_project",
    "rename_project",
    "ensure_projects_available",
    "load_project_from_disk",
]


"""Operations for manipulating project arrays."""

from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
from typing import Mapping

import numpy as np

from app.storage import project_storage

from .registry import (
    ProjectRegistry,
    get_project,
    load_project_from_disk,
    project_registry,
    store_project,
)


class ArrayAlreadyExistsError(Exception):
    """Array name already in use."""


class ArrayNotFoundError(Exception):
    """Array doesn't exist in project."""


def append_arrays(
    project_name: str,
    arrays_to_add: Mapping[str, np.ndarray],
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> OrderedDict[str, np.ndarray]:
    """Append multiple arrays to an existing project."""

    safe_project_name = Path(project_name).name

    normalized_items: OrderedDict[str, np.ndarray] = OrderedDict()
    for raw_name, value in arrays_to_add.items():
        normalized_name = _normalize_array_name(raw_name)
        if normalized_name in normalized_items:
            raise ValueError("Duplicate array names detected in upload.")
        normalized_items[normalized_name] = np.array(value)

    if not normalized_items:
        raise ValueError("No arrays provided for upload.")

    arrays = get_project(safe_project_name, registry=registry)
    if arrays is None and not load_project_from_disk(
        safe_project_name, registry=registry, storage=storage
    ):
        raise FileNotFoundError(f"Project {safe_project_name!r} not found")

    arrays = get_project(safe_project_name, registry=registry)
    if arrays is None:
        raise FileNotFoundError(f"Project {safe_project_name!r} not found")

    duplicates = set(normalized_items.keys()) & set(arrays.keys())
    if duplicates:
        duplicate_list = ", ".join(sorted(duplicates))
        raise ArrayAlreadyExistsError(
            f"Arrays {duplicate_list} already exist in {safe_project_name!r}"
        )

    updated = OrderedDict(arrays.items())
    for name, value in normalized_items.items():
        updated[name] = np.array(value)

    storage.write_npz(safe_project_name, updated)
    store_project(safe_project_name, updated, registry=registry)
    storage.ensure_project_manifest(safe_project_name, updated)
    return updated


def append_array(
    project_name: str,
    array_name: str,
    array: np.ndarray,
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> OrderedDict[str, np.ndarray]:
    """Add a new array to an existing project."""

    return append_arrays(
        project_name,
        OrderedDict([(array_name, array)]),
        registry=registry,
        storage=storage,
    )


def rename_array(
    project_name: str,
    array_id: str,
    new_name: str,
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> str:
    """Rename an array within an existing project."""

    safe_project_name = Path(project_name).name
    normalized_new_name = _normalize_array_name(new_name)

    arrays = get_project(safe_project_name, registry=registry)
    if arrays is None and not load_project_from_disk(
        safe_project_name, registry=registry, storage=storage
    ):
        raise FileNotFoundError(f"Project {safe_project_name!r} not found")

    arrays = get_project(safe_project_name, registry=registry)
    if arrays is None:
        raise FileNotFoundError(f"Project {safe_project_name!r} not found")

    manifest = storage.ensure_project_manifest(safe_project_name, arrays)
    entry = storage.find_array_entry_by_id(manifest, array_id)
    if entry is None:
        raise ArrayNotFoundError(f"Array with id {array_id!r} not found")

    array_name = entry.get("name") or ""
    if not array_name:
        raise ArrayNotFoundError(f"Array with id {array_id!r} not found")

    if normalized_new_name == array_name:
        return array_name

    if normalized_new_name in arrays:
        raise ArrayAlreadyExistsError(
            f"Array {normalized_new_name!r} already exists in {safe_project_name!r}"
        )

    updated = OrderedDict()
    for key, value in arrays.items():
        if key == array_name:
            updated[normalized_new_name] = value
        else:
            updated[key] = value

    storage.write_npz(safe_project_name, updated)
    store_project(safe_project_name, updated, registry=registry)
    storage.update_array_entry_name(safe_project_name, array_id, normalized_new_name)
    storage.ensure_project_manifest(safe_project_name, updated)

    return normalized_new_name


def delete_array(
    project_name: str,
    array_id: str,
    *,
    registry: ProjectRegistry = project_registry,
    storage=project_storage,
) -> OrderedDict[str, np.ndarray]:
    """Remove an array from a project."""

    safe_project_name = Path(project_name).name

    arrays = get_project(safe_project_name, registry=registry)
    if arrays is None and not load_project_from_disk(
        safe_project_name, registry=registry, storage=storage
    ):
        raise FileNotFoundError(f"Project {safe_project_name!r} not found")

    arrays = get_project(safe_project_name, registry=registry)
    if arrays is None:
        raise FileNotFoundError(f"Project {safe_project_name!r} not found")

    manifest = storage.ensure_project_manifest(safe_project_name, arrays)
    entry = storage.find_array_entry_by_id(manifest, array_id)
    if entry is None:
        raise ArrayNotFoundError(f"Array with id {array_id!r} not found")

    array_name = entry.get("name") or ""
    if array_name not in arrays:
        raise ArrayNotFoundError(f"Array with id {array_id!r} not found")

    updated = OrderedDict((key, value) for key, value in arrays.items() if key != array_name)

    storage.write_npz(safe_project_name, updated)
    store_project(safe_project_name, updated, registry=registry)
    storage.remove_array_entry(safe_project_name, array_id)
    storage.ensure_project_manifest(safe_project_name, updated)

    return updated


def _normalize_array_name(value: str) -> str:
    """Normalize an incoming array name value."""

    candidate = str(value or "").strip()
    if not candidate:
        raise ValueError("Array name must be a non-empty string")

    candidate = candidate.replace("\\", "/").split("/")[-1].strip()
    if not candidate:
        raise ValueError("Array name must be a non-empty string")

    return candidate


__all__ = [
    "ArrayAlreadyExistsError",
    "ArrayNotFoundError",
    "append_array",
    "append_arrays",
    "delete_array",
    "rename_array",
]


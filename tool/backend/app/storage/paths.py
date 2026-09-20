"""Filesystem helpers for persisted project assets."""

from __future__ import annotations

import os
import re
import tempfile
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Mapping

import numpy as np

from . import _utils


def files_directory() -> Path:
    """Root dir for project uploads."""

    _utils._FILES_ROOT.mkdir(parents=True, exist_ok=True)
    return _utils._FILES_ROOT


def project_directory(file_name: str, *, ensure: bool = False) -> Path:
    """Gets directory for a project."""

    safe_name = Path(file_name).name
    directory = files_directory() / Path(safe_name).stem
    if ensure:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def project_display_name(file_name: str) -> str:
    """Human-friendly project name."""

    safe_name = Path(file_name).name
    stem = Path(safe_name).stem
    if not stem:
        return safe_name

    replaced = re.sub(r"[\-_]+", " ", stem).strip()
    if not replaced:
        replaced = stem

    lower = replaced.lower()
    upper = replaced.upper()
    if replaced in {lower, upper}:
        words = re.split(r"\s+", lower)
        replaced = " ".join(word.capitalize() for word in words if word)

    return replaced or stem


def legacy_archive_path(file_name: str) -> Path:
    """Old flat layout path (for backward compat)."""

    safe_name = Path(file_name).name
    return files_directory() / safe_name


def resolve_archive_path(file_name: str) -> Path:
    """Finds archive path, checks both new and old layouts."""

    safe_name = Path(file_name).name
    new_path = project_directory(safe_name) / safe_name
    if new_path.exists():
        return new_path
    legacy_path = legacy_archive_path(safe_name)
    if legacy_path.exists():
        return legacy_path
    return new_path


def upload_file_path(file_name: str) -> Path:
    """Path where project archive will be saved."""

    safe_name = Path(file_name).name
    directory = project_directory(safe_name, ensure=True)
    return directory / safe_name


def read_file_path(file_name: str) -> Path:
    """Path to existing project archive."""

    return resolve_archive_path(file_name)


def save_file(file_name: str, binary: bytes) -> Path:
    """Saves uploaded file to disk."""

    file_path = upload_file_path(file_name)
    _atomic_write(file_path, binary)
    return file_path


def write_npz(file_name: str, arrays: Mapping[str, np.ndarray]) -> Path:
    """Saves arrays as compressed NPZ file."""

    safe_name = Path(file_name).name
    file_path = upload_file_path(safe_name)

    sanitized = OrderedDict()
    for key, array in arrays.items():
        if not isinstance(key, str) or not key.strip():
            raise ValueError("Array names must be non-empty strings")
        sanitized[key] = np.array(array)

    _atomic_write_npz(file_path, sanitized)
    return file_path


def _atomic_write(file_path: Path, data: bytes) -> None:
    """Write bytes to disk atomically."""

    file_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="wb",
        dir=file_path.parent,
        prefix=f".{file_path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        temp_path = Path(handle.name)
        handle.write(data)
        handle.flush()
        try:
            handle.fileno()
        except OSError:
            pass
        else:
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
    temp_path.replace(file_path)


def _atomic_write_npz(file_path: Path, arrays: Mapping[str, np.ndarray]) -> None:
    """Write NPZ data to disk atomically."""

    file_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="wb",
        dir=file_path.parent,
        prefix=f".{file_path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        temp_path = Path(handle.name)
        np.savez_compressed(handle, **arrays)
        handle.flush()
        try:
            handle.fileno()
        except OSError:
            pass
        else:
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
    temp_path.replace(file_path)


def file_exists(file_name: str) -> bool:
    """Checks if project file exists."""

    safe_name = Path(file_name).name
    if (project_directory(safe_name) / safe_name).exists():
        return True
    return legacy_archive_path(safe_name).exists()


def list_files() -> List[Dict[str, Any]]:
    """Lists all NPZ files."""

    root = files_directory()
    files: List[Dict[str, Any]] = []

    for path in sorted(root.glob("*/*.npz")):
        stat = path.stat()
        files.append({
            "name": path.name,
            "size_bytes": stat.st_size,
        })

    for path in sorted(root.glob("*.npz")):
        if any(entry["name"] == path.name for entry in files):
            continue
        stat = path.stat()
        files.append({
            "name": path.name,
            "size_bytes": stat.st_size,
        })

    return files

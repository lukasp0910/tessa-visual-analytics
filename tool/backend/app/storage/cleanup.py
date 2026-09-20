"""Utilities for cleaning up stored project artefacts."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Tuple

from ._utils import _PROJECT_INFO_FILENAME, _remove_directory_tree, _remove_path
from .manifest import (
    _legacy_flat_visibility_file_path,
    _legacy_visibility_file_path,
    project_info_path,
)
from .paths import files_directory, legacy_archive_path, project_directory


def cleanup_stale_project_directories() -> List[Path]:
    """Remove project directories that no longer contain project assets."""

    root = files_directory()
    removed: List[Path] = []

    if not root.exists():
        return removed

    try:
        entries = sorted(root.iterdir())
    except FileNotFoundError:
        return removed

    for entry in entries:
        if not entry.is_dir():
            continue

        has_project_assets = False
        try:
            for child in entry.rglob("*"):
                if not child.is_file():
                    continue
                if child.suffix.lower() == ".npz":
                    has_project_assets = True
                    break
                if child.name.lower() == _PROJECT_INFO_FILENAME.lower():
                    has_project_assets = True
                    break
        except FileNotFoundError:
            has_project_assets = False
        except PermissionError:
            has_project_assets = False

        if has_project_assets:
            continue

        if _remove_directory_tree(entry):
            removed.append(entry)

    return removed


def delete_file(file_name: str) -> Tuple[bool, Dict[str, bool]]:
    """Delete a stored project archive and its metadata."""

    safe_name = Path(file_name).name

    removed_archive = False
    removed_manifest = False
    removed_visibility_legacy = False
    removed_visibility_flat = False
    removed_directory = False

    archive_path = project_directory(safe_name) / safe_name
    if _remove_path(archive_path):
        removed_archive = True

    legacy_path = legacy_archive_path(safe_name)
    if legacy_path != archive_path and _remove_path(legacy_path):
        removed_archive = True

    info_path = project_info_path(safe_name)
    if _remove_path(info_path):
        removed_manifest = True

    legacy_visibility = _legacy_visibility_file_path(safe_name)
    if _remove_path(legacy_visibility):
        removed_visibility_legacy = True

    flat_visibility = _legacy_flat_visibility_file_path(safe_name)
    if _remove_path(flat_visibility):
        removed_visibility_flat = True

    project_dir = project_directory(safe_name)
    if _remove_directory_tree(project_dir):
        removed_directory = True

    removed_any = any(
        (
            removed_archive,
            removed_manifest,
            removed_visibility_legacy,
            removed_visibility_flat,
            removed_directory,
        )
    )

    details = {
        "removed_archive": removed_archive,
        "removed_manifest": removed_manifest,
        "removed_visibility_legacy": removed_visibility_legacy,
        "removed_visibility_flat": removed_visibility_flat,
        "removed_directory": removed_directory,
    }

    return removed_any, details


def remove_project_directory(file_name: str) -> bool:
    """Remove the directory allocated to a project and its contents."""

    safe_name = Path(file_name).name
    project_dir = project_directory(safe_name)

    return _remove_directory_tree(project_dir)

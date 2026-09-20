"""Compatibility layer for legacy imports.

New code should prefer :class:`ProjectStorageService` from :mod:`app.storage` or the
more focused modules in this package. This module re-exports the previous helper
functions to ease the transition.
"""

from __future__ import annotations

from . import ProjectStorageService, project_storage
from .cleanup import cleanup_stale_project_directories, delete_file, remove_project_directory
from .manifest import (
    ensure_project_manifest,
    find_array_entry_by_id,
    find_array_entry_by_name,
    load_project_info,
    load_project_manifest,
    project_info_path,
    remove_array_entry,
    save_project_info,
    save_project_manifest,
    update_array_entry_name,
    update_project_info,
)
from .paths import (
    file_exists,
    files_directory,
    legacy_archive_path,
    list_files,
    project_directory,
    project_display_name,
    read_file_path,
    resolve_archive_path,
    save_file,
    upload_file_path,
    write_npz,
)
from .visibility import delete_visibility_config, load_visibility_config, save_visibility_config


def rename_file(old_name: str, new_name: str):
    """Delegate to :class:`ProjectStorageService` for backward compatibility."""

    return project_storage.rename_file(old_name, new_name)


__all__ = [
    "ProjectStorageService",
    "cleanup_stale_project_directories",
    "delete_file",
    "delete_visibility_config",
    "ensure_project_manifest",
    "file_exists",
    "files_directory",
    "find_array_entry_by_id",
    "find_array_entry_by_name",
    "legacy_archive_path",
    "list_files",
    "load_project_info",
    "load_project_manifest",
    "load_visibility_config",
    "project_directory",
    "project_display_name",
    "project_info_path",
    "project_storage",
    "read_file_path",
    "remove_array_entry",
    "remove_project_directory",
    "rename_file",
    "resolve_archive_path",
    "save_file",
    "save_project_info",
    "save_project_manifest",
    "save_visibility_config",
    "update_array_entry_name",
    "update_project_info",
    "upload_file_path",
    "write_npz",
]

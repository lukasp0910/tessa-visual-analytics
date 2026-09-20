"""High-level interface for accessing storage helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from . import chart_types, cleanup, manifest, paths, sheets, visibility


class ProjectStorageService:
    """Facade that orchestrates storage helper modules."""

    # Path helpers -----------------------------------------------------

    def files_directory(self) -> Path:
        return paths.files_directory()

    def project_directory(self, file_name: str, *, ensure: bool = False) -> Path:
        return paths.project_directory(file_name, ensure=ensure)

    def project_display_name(self, file_name: str) -> str:
        return paths.project_display_name(file_name)

    def legacy_archive_path(self, file_name: str) -> Path:
        return paths.legacy_archive_path(file_name)

    def resolve_archive_path(self, file_name: str) -> Path:
        return paths.resolve_archive_path(file_name)

    def upload_file_path(self, file_name: str) -> Path:
        return paths.upload_file_path(file_name)

    def read_file_path(self, file_name: str) -> Path:
        return paths.read_file_path(file_name)

    def save_file(self, file_name: str, binary: bytes) -> Path:
        return paths.save_file(file_name, binary)

    def write_npz(self, file_name: str, arrays: Mapping[str, Any]) -> Path:
        return paths.write_npz(file_name, arrays)

    def file_exists(self, file_name: str) -> bool:
        return paths.file_exists(file_name)

    def list_files(self) -> List[Dict[str, Any]]:
        return paths.list_files()

    # Manifest helpers -------------------------------------------------

    def project_info_path(self, file_name: str, *, ensure: bool = False) -> Path:
        return manifest.project_info_path(file_name, ensure=ensure)

    def load_project_manifest(self, file_name: str) -> Dict[str, Any]:
        return manifest.load_project_manifest(file_name)

    def save_project_manifest(self, file_name: str, data: Dict[str, Any]) -> Path:
        return manifest.save_project_manifest(file_name, data)

    def ensure_project_manifest(
        self,
        file_name: str,
        arrays: Optional[Mapping[str, Any] | Iterable[str]] = None,
    ) -> Dict[str, Any]:
        return manifest.ensure_project_manifest(file_name, arrays)

    def load_project_info(self, file_name: str) -> Dict[str, Any]:
        return manifest.load_project_info(file_name)

    def save_project_info(self, file_name: str, info: Dict[str, Any]) -> Path:
        return manifest.save_project_info(file_name, info)

    def update_project_info(self, file_name: str, updates: Dict[str, Any]) -> Path:
        return manifest.update_project_info(file_name, updates)

    def find_array_entry_by_id(
        self, manifest_data: Dict[str, Any], array_id: str
    ) -> Optional[Dict[str, Any]]:
        return manifest.find_array_entry_by_id(manifest_data, array_id)

    def find_array_entry_by_name(
        self, manifest_data: Dict[str, Any], array_name: str
    ) -> Optional[Dict[str, Any]]:
        return manifest.find_array_entry_by_name(manifest_data, array_name)

    def update_array_entry_name(self, file_name: str, array_id: str, new_name: str) -> None:
        manifest.update_array_entry_name(file_name, array_id, new_name)

    def remove_array_entry(self, file_name: str, array_id: str) -> None:
        manifest.remove_array_entry(file_name, array_id)

    def time_axis_from_manifest(
        self, manifest_data: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        return manifest.time_axis_from_manifest(manifest_data)

    def load_time_axis(
        self,
        file_name: str,
        arrays: Optional[Mapping[str, Any] | Iterable[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        return manifest.load_time_axis(file_name, arrays)

    def save_time_axis(
        self,
        file_name: str,
        selection: Optional[Dict[str, Any]],
        *,
        arrays: Optional[Mapping[str, Any] | Iterable[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        return manifest.save_time_axis(file_name, selection, arrays=arrays)

    def load_time_controls(self, file_name: str) -> Optional[Dict[str, Any]]:
        return manifest.load_time_controls(file_name)

    def save_time_controls(
        self,
        file_name: str,
        selection: Optional[Mapping[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        return manifest.save_time_controls(file_name, selection)

    # Sheet helpers ----------------------------------------------------

    def sheet_config_path(self, file_name: str, *, ensure: bool = False) -> Path:
        return sheets.sheet_config_path(file_name, ensure=ensure)

    def load_sheet_config(self, file_name: str) -> Dict[str, Any]:
        return sheets.load_sheet_config(file_name)

    def save_sheet_config(self, file_name: str, config: Dict[str, Any]) -> Path:
        return sheets.save_sheet_config(file_name, config)

    def ensure_sheet_config(self, file_name: str) -> Dict[str, Any]:
        return sheets.ensure_sheet_config(file_name)

    def add_sheet(
        self,
        file_name: str,
        name: str | None = None,
        *,
        row_count: int | None = None,
        column_count: int | None = None,
    ) -> Dict[str, Any]:
        return sheets.add_sheet(
            file_name,
            name=name,
            row_count=row_count,
            column_count=column_count,
        )

    def update_sheet(
        self,
        file_name: str,
        sheet_id: str,
        *,
        name: str | None = None,
        cards: List[Dict[str, Any]] | None = None,
    ) -> Dict[str, Any]:
        return sheets.update_sheet(file_name, sheet_id, name=name, cards=cards)

    def delete_sheet(self, file_name: str, sheet_id: str) -> Dict[str, Any]:
        return sheets.delete_sheet(file_name, sheet_id)

    def set_last_active_card(
        self, file_name: str, sheet_id: str, card_id: str | None
    ) -> Dict[str, Any]:
        return sheets.set_last_active_card(file_name, sheet_id, card_id)

    def set_last_active_sheet(
        self, file_name: str, sheet_id: str | None
    ) -> Dict[str, Any]:
        return sheets.set_last_active_sheet(file_name, sheet_id)

    # Visibility helpers ----------------------------------------------

    def load_visibility_config(self, file_name: str) -> Dict[str, Any]:
        return visibility.load_visibility_config(file_name)

    def save_visibility_config(self, file_name: str, config: Dict[str, Any]) -> Path:
        return visibility.save_visibility_config(file_name, config)

    def delete_visibility_config(self, file_name: str) -> bool:
        return visibility.delete_visibility_config(file_name)

    # Cleanup helpers --------------------------------------------------

    def cleanup_stale_project_directories(self) -> List[Path]:
        return cleanup.cleanup_stale_project_directories()

    def delete_file(self, file_name: str) -> Tuple[bool, Dict[str, bool]]:
        return cleanup.delete_file(file_name)

    def remove_project_directory(self, file_name: str) -> bool:
        return cleanup.remove_project_directory(file_name)

    # Composite helpers ------------------------------------------------

    def rename_file(self, old_name: str, new_name: str) -> Path:
        safe_old = Path(old_name).name
        safe_new = Path(new_name).name

        old_directory = paths.project_directory(safe_old)
        new_directory = paths.project_directory(safe_new)
        old_path = paths.resolve_archive_path(safe_old)

        if safe_old == safe_new:
            if not old_path.exists():
                raise FileNotFoundError(f"Project {safe_old!r} not found")
            return old_path

        if not old_path.exists():
            raise FileNotFoundError(f"Project {safe_old!r} not found")

        directory_renamed = False
        if (
            safe_old != safe_new
            and old_directory.exists()
            and old_directory.is_dir()
            and old_path.parent == old_directory
        ):
            if new_directory.exists():
                try:
                    next(new_directory.iterdir())
                except StopIteration:
                    pass
                else:
                    raise FileExistsError(f"Project {safe_new!r} already exists")
            old_directory.rename(new_directory)
            directory_renamed = True
            old_path = new_directory / old_path.name

        new_path = paths.project_directory(safe_new, ensure=True) / safe_new

        if new_path.exists():
            raise FileExistsError(f"Project {safe_new!r} already exists")

        new_path.parent.mkdir(parents=True, exist_ok=True)
        old_path.rename(new_path)

        old_info = manifest.project_info_path(safe_old)
        if directory_renamed and not old_info.exists():
            relocated_info = new_directory / old_info.name
            if relocated_info.exists():
                old_info = relocated_info
        new_info = manifest.project_info_path(safe_new, ensure=True)
        if old_info.exists():
            if new_info.exists() and new_info != old_info:
                new_info.unlink()
            try:
                old_info.replace(new_info)
            except OSError:
                pass

        if directory_renamed:
            legacy_directory = paths.project_directory(safe_old)
            if legacy_directory.exists() and legacy_directory != paths.files_directory():
                try:
                    next(legacy_directory.iterdir())
                except StopIteration:
                    legacy_directory.rmdir()

        manifest.update_project_info(
            safe_new,
            {"name": paths.project_display_name(safe_new), "file_name": safe_new},
        )

        return new_path


project_storage = ProjectStorageService()

__all__ = ["ProjectStorageService", "project_storage"]

"""Management helpers for project manifest metadata."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from ._utils import (
    _PROJECT_INFO_FILENAME,
    _generate_id,
    _load_manifest,
    _now_iso,
)
from .paths import legacy_archive_path, project_directory, project_display_name


_TIME_AXIS_SOURCES = {"auto", "manual", "unknown"}


def _normalize_timesteps(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        candidate = int(value)
        if candidate > 0:
            return candidate
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            candidate = int(stripped)
        except ValueError:
            return None
        if candidate > 0:
            return candidate
    return None


def _normalize_analysis_scope(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if not text:
        return None
    if text in {"all", "matching"}:
        return text
    return None


def _normalize_non_negative_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if number >= 0 else None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            number = float(stripped)
        except ValueError:
            return None
        return number if number >= 0 else None
    return None


def _normalize_positive_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if number > 0 else None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            number = float(stripped)
        except ValueError:
            return None
        return number if number > 0 else None
    return None


def _normalize_boolean_flag(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value == 0:
            return False
        if value == 1:
            return True
    if isinstance(value, str):
        stripped = value.strip().lower()
        if not stripped:
            return None
        if stripped in {"true", "1", "yes", "on"}:
            return True
        if stripped in {"false", "0", "no", "off"}:
            return False
    return None


def _normalize_time_controls_entry(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None

    timesteps = _normalize_timesteps(value.get("timesteps"))
    if timesteps is None:
        # Support legacy key
        timesteps = _normalize_timesteps(value.get("selected_timesteps"))

    scope = _normalize_analysis_scope(value.get("analysis_scope"))
    recording_duration = _normalize_non_negative_number(value.get("recording_duration"))
    playback_speed = _normalize_positive_number(value.get("playback_speed"))
    playback_original_speed = _normalize_boolean_flag(value.get("playback_original_speed"))

    normalized: Dict[str, Any] = {}
    if timesteps is not None:
        normalized["timesteps"] = timesteps
    if scope:
        normalized["analysis_scope"] = scope
    if recording_duration is not None:
        normalized["recording_duration"] = recording_duration
    if playback_speed is not None:
        normalized["playback_speed"] = playback_speed
    if playback_original_speed is not None:
        normalized["playback_original_speed"] = playback_original_speed

    return normalized or None


def _clean_text(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def _time_axis_lookup(
    entries: Iterable[Dict[str, Any]] | None,
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    name_lookup: Dict[str, Dict[str, Any]] = {}
    id_lookup: Dict[str, Dict[str, Any]] = {}

    if not isinstance(entries, Iterable):
        return name_lookup, id_lookup

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        entry_id = _clean_text(entry.get("id")) or _generate_id()
        entry_name = _clean_text(entry.get("name"))
        if entry_name:
            name_lookup[entry_name] = entry
        id_lookup[entry_id] = entry

    return name_lookup, id_lookup


def _normalize_time_axis_entry(
    value: Any,
    *,
    name_lookup: Mapping[str, Dict[str, Any]] | None = None,
    id_lookup: Mapping[str, Dict[str, Any]] | None = None,
) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None

    array_id = _clean_text(value.get("array_id"))
    array_name = _clean_text(value.get("array_name"))

    entry: Optional[Dict[str, Any]] = None
    if array_id and id_lookup and array_id in id_lookup:
        entry = id_lookup[array_id]
    elif array_name and name_lookup and array_name in name_lookup:
        entry = name_lookup[array_name]

    if entry is None:
        array_id = None
        array_name = None
    else:
        array_id = _clean_text(entry.get("id"))
        array_name = _clean_text(entry.get("name")) or array_name

    if array_id is None and array_name is None:
        return None

    normalized: Dict[str, Any] = {}
    if array_id:
        normalized["array_id"] = array_id
    if array_name:
        normalized["array_name"] = array_name

    source = _clean_text(value.get("source"))
    if source:
        source = source.lower()
        if source in _TIME_AXIS_SOURCES:
            normalized["source"] = source
        else:
            normalized["source"] = "unknown"

    return normalized or None


def time_axis_from_manifest(manifest: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    project_section = manifest.get("project")
    if not isinstance(project_section, dict):
        return None

    arrays_section = manifest.get("arrays")
    name_lookup, id_lookup = _time_axis_lookup(arrays_section if isinstance(arrays_section, list) else [])

    return _normalize_time_axis_entry(
        project_section.get("time_axis"),
        name_lookup=name_lookup,
        id_lookup=id_lookup,
    )


def _apply_time_axis(
    manifest: Dict[str, Any],
    selection: Optional[Dict[str, Any]],
    *,
    name_lookup: Mapping[str, Dict[str, Any]] | None = None,
    id_lookup: Mapping[str, Dict[str, Any]] | None = None,
) -> bool:
    project_section = manifest.setdefault("project", {})
    if not isinstance(project_section, dict):
        project_section = {}
        manifest["project"] = project_section

    existing = project_section.get("time_axis")
    normalized_existing = _normalize_time_axis_entry(
        existing,
        name_lookup=name_lookup,
        id_lookup=id_lookup,
    )
    changed = False

    if "time_axis" not in project_section:
        project_section["time_axis"] = None
        changed = True

    if normalized_existing != existing:
        project_section["time_axis"] = normalized_existing
        changed = True

    normalized_selection = _normalize_time_axis_entry(
        selection,
        name_lookup=name_lookup,
        id_lookup=id_lookup,
    )

    if normalized_selection != project_section.get("time_axis"):
        project_section["time_axis"] = normalized_selection
        changed = True

    return changed


def project_info_path(file_name: str, *, ensure: bool = False) -> Path:
    """Path to project info file."""

    safe_name = Path(file_name).name
    directory = project_directory(safe_name, ensure=ensure)
    return directory / _PROJECT_INFO_FILENAME


def _legacy_visibility_file_path(file_name: str) -> Path:
    safe_name = Path(file_name).name
    directory = project_directory(safe_name)
    return directory / f"{Path(safe_name).stem}_metadata.json"


def _legacy_flat_visibility_file_path(file_name: str) -> Path:
    safe_name = Path(file_name).name
    return legacy_archive_path(safe_name).with_name(f"{safe_name}.visibility.json")


def _load_legacy_visibility(file_name: str) -> Dict[str, Dict[str, Any]]:
    visibility: Dict[str, Dict[str, Any]] = {}
    for candidate in (
        _legacy_visibility_file_path(file_name),
        _legacy_flat_visibility_file_path(file_name),
    ):
        if not candidate.exists():
            continue
        try:
            with candidate.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        arrays = data.get("arrays")
        if not isinstance(arrays, dict):
            continue
        for name, entry in arrays.items():
            if isinstance(name, str) and isinstance(entry, dict):
                visibility[name] = entry
    return visibility


def load_project_manifest(file_name: str) -> Dict[str, Any]:
    safe_name = Path(file_name).name
    manifest = _load_manifest(project_info_path(safe_name))

    if not isinstance(manifest.get("project"), dict):
        project_section: Dict[str, Any] = {}
        if isinstance(manifest, dict):
            for key in (
                "name",
                "description",
                "created_at",
                "file_name",
                "title",
                "display_name",
            ):
                if key in manifest and key != "project":
                    project_section[key] = manifest.pop(key)
        manifest = dict(manifest) if isinstance(manifest, dict) else {}
        manifest["project"] = project_section

    project_section = manifest.setdefault("project", {})
    if not isinstance(project_section, dict):
        project_section = {}
        manifest["project"] = project_section

    project_section.setdefault("id", _generate_id())
    project_section["file_name"] = safe_name

    arrays_section = manifest.get("arrays")
    if not isinstance(arrays_section, list):
        arrays_section = []
        manifest["arrays"] = arrays_section

    visibility_section = manifest.get("visibility")
    if not isinstance(visibility_section, dict):
        manifest["visibility"] = {"arrays": {}}
    elif not isinstance(visibility_section.get("arrays"), dict):
        visibility_section["arrays"] = {}

    name_lookup, id_lookup = _time_axis_lookup(arrays_section)
    _apply_time_axis(
        manifest,
        project_section.get("time_axis"),
        name_lookup=name_lookup,
        id_lookup=id_lookup,
    )

    return manifest


def save_project_manifest(file_name: str, manifest: Dict[str, Any]) -> Path:
    safe_name = Path(file_name).name
    project_section = manifest.setdefault("project", {})
    if not isinstance(project_section, dict):
        project_section = {}
        manifest["project"] = project_section
    project_section.setdefault("id", _generate_id())
    project_section["file_name"] = safe_name
    project_section.setdefault("updated_at", _now_iso())

    path = project_info_path(safe_name, ensure=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)

    legacy_path = _legacy_visibility_file_path(safe_name)
    if legacy_path.exists():
        legacy_path.unlink()
    flat_path = _legacy_flat_visibility_file_path(safe_name)
    if flat_path.exists():
        flat_path.unlink()

    return path


def ensure_project_manifest(
    file_name: str,
    arrays: Optional[Mapping[str, Any] | Iterable[str]] = None,
) -> Dict[str, Any]:
    safe_name = Path(file_name).name
    manifest = load_project_manifest(safe_name)
    project_section = manifest.setdefault("project", {})
    if not isinstance(project_section, dict):
        project_section = {}
        manifest["project"] = project_section

    arrays_section = manifest.get("arrays")
    if not isinstance(arrays_section, list):
        arrays_section = []
    clean_entries: List[Dict[str, Any]] = []
    name_lookup: Dict[str, Dict[str, Any]] = {}
    id_lookup: Dict[str, Dict[str, Any]] = {}
    changed = False

    for entry in arrays_section:
        if not isinstance(entry, dict):
            changed = True
            continue
        entry_id = str(entry.get("id") or "").strip() or _generate_id()
        entry_name = str(entry.get("name") or "").strip()
        if entry_id != entry.get("id"):
            entry["id"] = entry_id
            changed = True
        if entry_name != entry.get("name"):
            entry["name"] = entry_name
            changed = True
        clean_entries.append(entry)
        if entry_name:
            name_lookup[entry_name] = entry
        id_lookup[entry_id] = entry

    manifest["arrays"] = clean_entries

    if arrays is not None:
        if isinstance(arrays, Mapping):
            array_names = [str(key) for key in arrays.keys()]
        else:
            array_names = [str(name) for name in arrays]

        ordered_entries: List[Dict[str, Any]] = []
        seen_ids: set[str] = set()
        now = _now_iso()
        legacy_visibility = _load_legacy_visibility(safe_name)
        visibility_section = manifest.setdefault("visibility", {})
        if not isinstance(visibility_section, dict):
            visibility_section = {}
            manifest["visibility"] = visibility_section
        arrays_visibility = visibility_section.setdefault("arrays", {})
        if not isinstance(arrays_visibility, dict):
            arrays_visibility = {}
            visibility_section["arrays"] = arrays_visibility

        for name in array_names:
            if not name:
                continue
            entry = name_lookup.get(name)
            if entry is None:
                entry = {"id": _generate_id(), "name": name, "created_at": now}
                changed = True
            else:
                if entry.get("name") != name:
                    entry["name"] = name
                    changed = True
                entry.setdefault("created_at", now)
            entry["updated_at"] = now
            ordered_entries.append(entry)
            seen_ids.add(entry["id"])
            name_lookup[name] = entry
            id_lookup[entry["id"]] = entry

            if name in legacy_visibility and entry["id"] not in arrays_visibility:
                arrays_visibility[entry["id"]] = legacy_visibility[name]
                changed = True

        if ordered_entries != clean_entries:
            manifest["arrays"] = ordered_entries
            changed = True

        for array_id in list(arrays_visibility.keys()):
            if array_id not in seen_ids:
                arrays_visibility.pop(array_id, None)
                changed = True

        for candidate in (
            _legacy_visibility_file_path(safe_name),
            _legacy_flat_visibility_file_path(safe_name),
        ):
            if candidate.exists():
                candidate.unlink()
                changed = True

    if _apply_time_axis(
        manifest,
        project_section.get("time_axis"),
        name_lookup=name_lookup,
        id_lookup=id_lookup,
    ):
        changed = True

    if changed:
        save_project_manifest(safe_name, manifest)

    return manifest


def load_project_info(file_name: str) -> Dict[str, Any]:
    manifest = load_project_manifest(file_name)
    project = manifest.get("project")
    if not isinstance(project, dict):
        return {}
    return project


def save_project_info(file_name: str, info: Dict[str, Any]) -> Path:
    manifest = load_project_manifest(file_name)
    project_section = manifest.setdefault("project", {})
    if not isinstance(project_section, dict):
        project_section = {}
        manifest["project"] = project_section

    for key, value in (info or {}).items():
        if value is None:
            continue
        if key in {
            "name",
            "description",
            "created_at",
            "file_name",
            "title",
            "display_name",
        }:
            text = str(value).strip()
            if key == "name":
                safe_name = Path(file_name).name
                if not text:
                    text = project_display_name(safe_name)
                elif text.lower().endswith(".npz") or text == safe_name:
                    text = project_display_name(text)
            project_section[key] = text
        else:
            project_section[key] = value

    project_section.setdefault("created_at", _now_iso())
    project_section["updated_at"] = _now_iso()

    return save_project_manifest(file_name, manifest)


def update_project_info(file_name: str, updates: Dict[str, Any]) -> Path:
    manifest = load_project_manifest(file_name)
    project_section = manifest.setdefault("project", {})
    if not isinstance(project_section, dict):
        project_section = {}
        manifest["project"] = project_section

    if isinstance(updates, dict):
        for key, value in updates.items():
            project_section[key] = value

    project_section.setdefault("created_at", _now_iso())
    project_section["updated_at"] = _now_iso()

    return save_project_manifest(file_name, manifest)


def find_array_entry_by_id(
    manifest: Dict[str, Any], array_id: str
) -> Optional[Dict[str, Any]]:
    entries = manifest.get("arrays")
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if isinstance(entry, dict) and entry.get("id") == array_id:
            return entry
    return None


def find_array_entry_by_name(
    manifest: Dict[str, Any], array_name: str
) -> Optional[Dict[str, Any]]:
    entries = manifest.get("arrays")
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if isinstance(entry, dict) and entry.get("name") == array_name:
            return entry
    return None


def update_array_entry_name(file_name: str, array_id: str, new_name: str) -> None:
    manifest = ensure_project_manifest(file_name)
    entry = find_array_entry_by_id(manifest, array_id)
    if entry is None:
        return
    if entry.get("name") == new_name:
        return
    entry["name"] = new_name
    entry["updated_at"] = _now_iso()
    manifest.setdefault("project", {}).setdefault("created_at", _now_iso())
    manifest["project"]["updated_at"] = _now_iso()
    save_project_manifest(file_name, manifest)


def remove_array_entry(file_name: str, array_id: str) -> None:
    manifest = ensure_project_manifest(file_name)
    entries = manifest.get("arrays")
    if not isinstance(entries, list):
        return
    filtered = [
        entry
        for entry in entries
        if not (isinstance(entry, dict) and entry.get("id") == array_id)
    ]
    if len(filtered) == len(entries):
        return
    manifest["arrays"] = filtered
    visibility = manifest.get("visibility")
    if isinstance(visibility, dict) and isinstance(visibility.get("arrays"), dict):
        visibility["arrays"].pop(array_id, None)
    manifest.setdefault("project", {}).setdefault("created_at", _now_iso())
    manifest["project"]["updated_at"] = _now_iso()
    save_project_manifest(file_name, manifest)


def load_time_axis(
    file_name: str,
    arrays: Optional[Mapping[str, Any] | Iterable[str]] = None,
) -> Optional[Dict[str, Any]]:
    manifest = ensure_project_manifest(file_name, arrays)
    return time_axis_from_manifest(manifest)


def save_time_axis(
    file_name: str,
    selection: Optional[Dict[str, Any]],
    *,
    arrays: Optional[Mapping[str, Any] | Iterable[str]] = None,
) -> Optional[Dict[str, Any]]:
    manifest = ensure_project_manifest(file_name, arrays)
    arrays_section = manifest.get("arrays")
    name_lookup, id_lookup = _time_axis_lookup(arrays_section if isinstance(arrays_section, list) else [])

    if not _apply_time_axis(
        manifest,
        selection,
        name_lookup=name_lookup,
        id_lookup=id_lookup,
    ):
        return time_axis_from_manifest(manifest)

    project_section = manifest.setdefault("project", {})
    if isinstance(project_section, dict):
        project_section.setdefault("created_at", _now_iso())
        project_section["updated_at"] = _now_iso()

    save_project_manifest(file_name, manifest)
    return time_axis_from_manifest(manifest)


def time_controls_from_manifest(manifest_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    project_section = manifest_data.get("project") if isinstance(manifest_data, dict) else None
    if not isinstance(project_section, dict):
        return None
    return _normalize_time_controls_entry(project_section.get("time_controls"))


def load_time_controls(file_name: str) -> Optional[Dict[str, Any]]:
    manifest_data = load_project_manifest(file_name)
    return time_controls_from_manifest(manifest_data)


def save_time_controls(
    file_name: str,
    selection: Optional[Mapping[str, Any] | Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    manifest_data = ensure_project_manifest(file_name)
    project_section = manifest_data.setdefault("project", {})
    if not isinstance(project_section, dict):
        project_section = {}
        manifest_data["project"] = project_section

    normalized = _normalize_time_controls_entry(selection)

    if normalized is None:
        project_section.pop("time_controls", None)
    else:
        project_section["time_controls"] = normalized

    project_section.setdefault("created_at", _now_iso())
    project_section["updated_at"] = _now_iso()

    save_project_manifest(file_name, manifest_data)
    return time_controls_from_manifest(manifest_data)

"""Internal helpers shared across storage modules."""

from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

_FILES_ROOT = Path(__file__).resolve().parents[2] / "files"
_PROJECT_INFO_FILENAME = "project.json"
_SHEETS_FILENAME = "sheet.json"


def _now_iso() -> str:
    """Current UTC timestamp."""

    return datetime.now(timezone.utc).isoformat()


def _generate_id() -> str:
    """Random hex ID for manifest entries."""

    return uuid.uuid4().hex


def _load_manifest(path: Path) -> Dict[str, Any]:
    """Load a JSON manifest document from disk if available."""

    if not path.exists():
        return {}

    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError, json.JSONDecodeError):
        return {}

    return data if isinstance(data, dict) else {}


def _remove_directory_tree(directory: Path) -> bool:
    """Remove a directory and its contents, tolerating deletion errors."""

    if not directory.exists():
        return False

    if not directory.is_dir():
        try:
            directory.unlink()
            return True
        except OSError:
            return False

    try:
        shutil.rmtree(directory)
    except FileNotFoundError:
        return True
    except OSError:
        try:
            shutil.rmtree(directory, ignore_errors=True)
        except TypeError:
            try:
                shutil.rmtree(directory)
            except OSError:
                pass
        if directory.exists():
            try:
                entries = sorted(
                    directory.rglob("*"),
                    key=lambda item: len(item.parts),
                    reverse=True,
                )
            except FileNotFoundError:
                entries = []
            for entry in entries:
                try:
                    if entry.is_dir():
                        entry.rmdir()
                    else:
                        entry.unlink()
                except FileNotFoundError:
                    continue
                except OSError:
                    pass
            try:
                directory.rmdir()
            except FileNotFoundError:
                return True
            except OSError:
                return False
    return not directory.exists()


def _remove_path(path: Path) -> bool:
    """Remove the provided filesystem path if it exists."""

    if not path.exists():
        return False

    if path.is_dir():
        return _remove_directory_tree(path)

    try:
        path.unlink()
        return True
    except OSError:
        return False

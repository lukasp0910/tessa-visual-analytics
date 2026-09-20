"""Helpers for persisting chart type configuration on disk."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from pydantic import ValidationError

from app.schemas.chart_types import ChartTypeRegistry


class ChartTypesConfigError(RuntimeError):
    """Can't load chart type config."""


@dataclass(frozen=True)
class ChartTypeCacheEntry:
    """Cached payload for the chart type registry."""

    registry: ChartTypeRegistry
    mtime: float
    path: Path


_CACHE_ENTRY: Optional[ChartTypeCacheEntry] = None


def chart_types_config_path() -> Path:
    """Path to chart types config."""

    return Path(__file__).resolve().parent / "config" / "chart_types.json"


def _load_registry(
    *, path: Optional[Path] = None, use_cache: bool = True
) -> ChartTypeCacheEntry:
    global _CACHE_ENTRY

    target = path or chart_types_config_path()

    if use_cache and _CACHE_ENTRY is not None and _CACHE_ENTRY.path == target:
        try:
            mtime = target.stat().st_mtime
        except OSError:
            pass
        else:
            if abs(mtime - _CACHE_ENTRY.mtime) < 1e-9:
                return _CACHE_ENTRY

    try:
        with target.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError as exc:
        raise ChartTypesConfigError(
            f"Chart type configuration not found at {target!s}"
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ChartTypesConfigError(
            f"Unable to read chart type configuration: {exc}"
        ) from exc

    try:
        registry = ChartTypeRegistry.model_validate(payload)
    except ValidationError as exc:
        raise ChartTypesConfigError("Invalid chart type configuration") from exc

    try:
        mtime = target.stat().st_mtime
    except OSError:
        mtime = 0.0

    entry = ChartTypeCacheEntry(registry=registry, mtime=mtime, path=target)
    if use_cache:
        _CACHE_ENTRY = entry
    return entry


def load_chart_type_registry(
    *, path: Optional[Path] = None, use_cache: bool = True
) -> ChartTypeRegistry:
    """Load the chart type registry from disk."""

    return _load_registry(path=path, use_cache=use_cache).registry


def load_chart_type_registry_with_metadata(
    *, path: Optional[Path] = None, use_cache: bool = True
) -> ChartTypeCacheEntry:
    """Load the chart type registry and return cache metadata."""

    return _load_registry(path=path, use_cache=use_cache)


def save_chart_type_registry(
    registry: ChartTypeRegistry, *, path: Optional[Path] = None
) -> Path:
    """Saves chart type config to disk."""

    target = path or chart_types_config_path()
    target.parent.mkdir(parents=True, exist_ok=True)

    serialized = registry.model_dump(by_alias=True)
    with target.open("w", encoding="utf-8") as handle:
        json.dump(serialized, handle, indent=2, sort_keys=True)
        handle.write("\n")

    try:
        mtime = target.stat().st_mtime
    except OSError:
        mtime = 0.0

    entry = ChartTypeCacheEntry(registry=registry, mtime=mtime, path=target)
    global _CACHE_ENTRY
    _CACHE_ENTRY = entry
    return target


def clear_chart_type_cache() -> None:
    """Clear the in-memory cache used for chart type configuration."""

    global _CACHE_ENTRY
    _CACHE_ENTRY = None

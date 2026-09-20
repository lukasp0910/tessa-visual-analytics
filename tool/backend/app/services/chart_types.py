"""Service helpers for chart type configuration."""

from __future__ import annotations

import copy
from typing import Any, Dict, Mapping, Optional

from app.schemas.chart_types import ChartTypeConfig, ChartTypeRegistry
from app.storage.chart_types import (
    ChartTypeCacheEntry,
    load_chart_type_registry_with_metadata,
)


def _freeze_mapping(payload: Any) -> Any:
    """Convert a potentially nested structure into a hashable representation."""

    if isinstance(payload, Mapping):
        return tuple(sorted((key, _freeze_mapping(value)) for key, value in payload.items()))
    if isinstance(payload, (list, tuple, set)):
        return tuple(_freeze_mapping(item) for item in payload)
    return payload


def _merge_payload(
    base: Mapping[str, Any], override: Mapping[str, Any]
) -> Dict[str, Any]:
    """Deep merge two mapping structures for override handling."""

    merged: Dict[str, Any] = {key: copy.deepcopy(value) for key, value in base.items()}
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(merged.get(key), Mapping):
            merged[key] = _merge_payload(merged[key], value)  # type: ignore[arg-type]
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def merge_chart_type_overrides(
    registry: ChartTypeRegistry, overrides: Mapping[str, Mapping[str, Any]]
) -> ChartTypeRegistry:
    """Apply a mapping of overrides to the base chart type registry."""

    payload = registry.model_dump(by_alias=True)
    types_list = payload.setdefault("types", [])

    for chart_name, override in overrides.items():
        if not isinstance(override, Mapping):
            continue
        update_payload = copy.deepcopy(dict(override))
        raw_name = update_payload.get("name")
        if isinstance(raw_name, str) and raw_name.strip():
            chart_key = raw_name.strip()
        else:
            chart_key = chart_name
            update_payload["name"] = chart_key

        replaced = False
        for index, entry in enumerate(types_list):
            if isinstance(entry, Mapping) and entry.get("name") == chart_key:
                merged_entry = _merge_payload(entry, update_payload)  # type: ignore[arg-type]
                types_list[index] = merged_entry
                replaced = True
                break
        if not replaced:
            types_list.append(update_payload)

    return ChartTypeRegistry.model_validate(payload)


class ChartTypeService:
    """High level orchestration for chart type configuration access."""

    def __init__(self, loader=load_chart_type_registry_with_metadata) -> None:
        self._loader = loader
        self._cache_entry: Optional[ChartTypeCacheEntry] = None
        self._override_cache: Dict[Any, ChartTypeRegistry] = {}

    def _load_registry(self, *, force_refresh: bool = False) -> ChartTypeCacheEntry:
        entry = self._loader(use_cache=not force_refresh)
        if self._cache_entry is None:
            self._cache_entry = entry
            return entry

        if (
            self._cache_entry.path != entry.path
            or abs(self._cache_entry.mtime - entry.mtime) >= 1e-9
        ):
            self._cache_entry = entry
            self._override_cache.clear()
            return entry

        self._cache_entry = entry
        return entry

    def get_registry(
        self,
        overrides: Optional[Mapping[str, Mapping[str, Any]]] = None,
        *,
        force_refresh: bool = False,
    ) -> ChartTypeRegistry:
        """Gets chart type registry with optional overrides."""

        entry = self._load_registry(force_refresh=force_refresh)
        if not overrides:
            return entry.registry

        key = _freeze_mapping(overrides)
        cached = self._override_cache.get(key)
        if cached is not None:
            return cached

        merged = merge_chart_type_overrides(entry.registry, overrides)
        self._override_cache[key] = merged
        return merged

    def get_chart_type(
        self,
        name: str,
        overrides: Optional[Mapping[str, Mapping[str, Any]]] = None,
        *,
        force_refresh: bool = False,
    ) -> Optional[ChartTypeConfig]:
        """Gets specific chart type config."""

        registry = self.get_registry(overrides=overrides, force_refresh=force_refresh)
        return registry.find(name)


chart_type_service = ChartTypeService()

__all__ = [
    "ChartTypeService",
    "chart_type_service",
    "merge_chart_type_overrides",
]

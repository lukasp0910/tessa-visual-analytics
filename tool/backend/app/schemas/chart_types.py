"""Pydantic models that describe chart type configuration."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ChartOptionField(BaseModel):
    """Definition for a configurable chart option field."""

    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    name: str
    label: str
    field_type: str = Field(alias="type")
    required: bool = False
    description: Optional[str] = None
    default: Any = None
    choices: Optional[List[Any]] = None
    allow_multiple: bool = Field(default=False, alias="allowMultiple")

    @field_validator("name", "label", "field_type")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        text = (value or "").strip()
        if not text:
            raise ValueError("value must be a non-empty string")
        return text

    @field_validator("choices")
    @classmethod
    def _clean_choices(cls, value: Optional[Iterable[Any]]):
        if value is None:
            return None
        cleaned = list(value)
        if not cleaned:
            raise ValueError("choices must be a non-empty sequence when provided")
        return cleaned


class ChartTypeConfig(BaseModel):
    """Configuration payload for a single chart type."""

    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    name: str
    label: str
    description: Optional[str] = None
    fields: List[ChartOptionField] = Field(default_factory=list)
    defaults: Dict[str, Any] = Field(default_factory=dict)
    options: Dict[str, Any] = Field(default_factory=dict)
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("name", "label")
    @classmethod
    def _require_non_empty(cls, value: str) -> str:
        text = (value or "").strip()
        if not text:
            raise ValueError("value must be a non-empty string")
        return text

    @field_validator("fields")
    @classmethod
    def _validate_fields(cls, value: List[ChartOptionField]):
        seen: set[str] = set()
        for field in value:
            if field.name in seen:
                raise ValueError(f"Duplicate chart option field name: {field.name}")
            seen.add(field.name)
        return value

    @field_validator("defaults", "options", "metadata", mode="before")
    @classmethod
    def _ensure_mapping(cls, value: Optional[Mapping[str, Any]]):
        if value is None:
            return {}
        if isinstance(value, Mapping):
            return dict(value)
        raise ValueError("defaults, options and metadata must be objects")


class ChartTypeRegistry(BaseModel):
    """Container that stores all available chart type definitions."""

    model_config = ConfigDict(populate_by_name=True)

    version: int = 1
    types: List[ChartTypeConfig] = Field(default_factory=list)

    @field_validator("types")
    @classmethod
    def _validate_unique_names(cls, value: List[ChartTypeConfig]):
        seen: set[str] = set()
        for entry in value:
            if entry.name in seen:
                raise ValueError(f"Duplicate chart type name: {entry.name}")
            seen.add(entry.name)
        return value

    def find(self, chart_type: str) -> Optional[ChartTypeConfig]:
        """Finds chart type config by name."""

        for entry in self.types:
            if entry.name == chart_type:
                return entry
        return None

    def as_mapping(self) -> Dict[str, ChartTypeConfig]:
        """Converts to dict mapping."""

        return {entry.name: entry for entry in self.types}

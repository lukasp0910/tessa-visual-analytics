"""Pydantic models describing sheet configuration payloads."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, validator


def _normalize_sheet_name(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    text = " ".join(text.split())
    if not text:
        raise ValueError("Sheet name cannot be empty")
    return text


class SheetCardCorner(BaseModel):
    """Corner coordinate describing a card position."""

    row: int = Field(ge=0)
    column: int = Field(ge=0)

    class Config:
        allow_population_by_field_name = True
        extra = "ignore"


class SheetCardConfiguration(BaseModel):
    """Chart configuration associated with a sheet card."""

    chart_type: Optional[str] = Field(default=None, alias="chartType")
    chart_type_label: Optional[str] = Field(default=None, alias="chartTypeLabel")
    data_source_id: Optional[str] = Field(default=None, alias="dataSourceId")
    data_source_label: Optional[str] = Field(default=None, alias="dataSourceLabel")
    field_values: Dict[str, Any] = Field(default_factory=dict, alias="fieldValues")

    class Config:
        allow_population_by_field_name = True
        extra = "allow"


class SheetCardEntry(BaseModel):
    """Placeholder card stored within a sheet."""

    id: str
    top_left: SheetCardCorner = Field(alias="topLeft")
    bottom_right: SheetCardCorner = Field(alias="bottomRight")
    configuration: Optional[SheetCardConfiguration] = None

    class Config:
        allow_population_by_field_name = True
        extra = "ignore"


class SheetEntry(BaseModel):
    """Representation of a sheet entry."""

    id: str
    name: str
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    row_count: int = Field(alias="rowCount", ge=1)
    column_count: int = Field(alias="columnCount", ge=1)
    cards: List[SheetCardEntry] = Field(default_factory=list)
    last_active_card_id: Optional[str] = Field(
        default=None, alias="lastActiveCardId"
    )

    class Config:
        allow_population_by_field_name = True
        extra = "ignore"


class SheetListResponse(BaseModel):
    """Response payload containing all sheet entries."""

    sheets: List[SheetEntry] = Field(default_factory=list)
    last_active_sheet_id: Optional[str] = Field(
        default=None, alias="lastActiveSheetId"
    )

    class Config:
        allow_population_by_field_name = True
        extra = "ignore"


class SheetCreateRequest(BaseModel):
    """Payload describing the data required to create a sheet."""

    name: Optional[str] = None
    row_count: int = Field(alias="rowCount", ge=1)
    column_count: int = Field(alias="columnCount", ge=1)
    cards: List[SheetCardEntry] = Field(default_factory=list)

    @validator("name")
    def _normalize_name(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure provided sheet names are sanitized."""

        if value is None:
            return value
        return _normalize_sheet_name(value)

    class Config:
        allow_population_by_field_name = True
        extra = "ignore"


class SheetUpdateRequest(BaseModel):
    """Payload describing updates to an existing sheet."""

    name: Optional[str] = None
    cards: Optional[List[SheetCardEntry]] = None

    @validator("name")
    def _normalize_name(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure provided sheet names are sanitized."""

        if value is None:
            return value
        return _normalize_sheet_name(value)

    class Config:
        extra = "ignore"


class SheetActiveUpdateRequest(BaseModel):
    """Payload describing a last active sheet preference update."""

    sheet_id: Optional[str] = Field(default=None, alias="sheetId")

    @validator("sheet_id")
    def _normalize_sheet_id(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure provided sheet identifiers are sanitized."""

        if value is None:
            return None
        text = str(value).strip()
        return text or None

    class Config:
        allow_population_by_field_name = True
        extra = "ignore"


class SheetActiveCardUpdateRequest(BaseModel):
    """Payload describing a last active card preference update."""

    card_id: Optional[str] = Field(default=None, alias="cardId")

    @validator("card_id")
    def _normalize_card_id(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure provided card identifiers are sanitized."""

        if value is None:
            return None
        text = str(value).strip()
        return text or None

    class Config:
        allow_population_by_field_name = True
        extra = "ignore"

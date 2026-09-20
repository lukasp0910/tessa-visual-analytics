"""Routes for exposing chart type configuration."""

from __future__ import annotations

from fastapi import APIRouter

from app.schemas.chart_types import ChartTypeRegistry
from app.services.chart_types import chart_type_service

router = APIRouter(prefix="/chart-types")


@router.get("", response_model=ChartTypeRegistry)
async def list_chart_types() -> ChartTypeRegistry:
    """Gets available chart types."""

    return chart_type_service.get_registry()

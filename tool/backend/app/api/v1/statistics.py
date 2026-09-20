"""Routes providing statistical summaries."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Path as PathParam

from app.api.v1.utils import resolve_project_array
from app.services import metadata


router = APIRouter(prefix="/statistics")


@router.get("/projects/{project_id}/arrays/{array_id}/columns/{column_index}/stats")
async def column_statistics(
    project_id: str,
    array_id: str,
    column_index: int = PathParam(..., ge=0),
):
    """Gets stats for specific column."""

    project_name, array_entry, array = resolve_project_array(project_id, array_id)

    try:
        stats = metadata.array_column_statistics(array, column_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail="Column not found") from exc

    return {
        "project": project_name,
        "array": array_entry.get("id"),
        "array_name": array_entry.get("name"),
        "column_index": column_index,
        "statistics": stats,
    }


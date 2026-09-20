"""Pydantic models describing UI interaction state."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

InteractionModeLiteral = Literal['explore', 'edit']


class InteractionModePayload(BaseModel):
    """Request payload specifying the desired interaction mode."""

    mode: InteractionModeLiteral = Field(
        description="Name of the interaction mode to activate.",
        examples=['explore'],
    )


class InteractionModeResponse(BaseModel):
    """Response body that reports the active interaction mode."""

    mode: InteractionModeLiteral = Field(
        description="Currently active interaction mode.",
        examples=['edit'],
    )


class ProjectSelectionPayload(BaseModel):
    """Request payload for persisting the last active project selection."""

    project_name: str | None = Field(
        default=None,
        description="Name of the project that should become active.",
        examples=['example-project'],
    )


class ProjectSelectionResponse(BaseModel):
    """Response payload that reports the stored active project selection."""

    project_name: str | None = Field(
        default=None,
        description="Name of the currently stored active project, if any.",
        examples=['example-project'],
    )


__all__ = [
    'InteractionModePayload',
    'InteractionModeResponse',
    'ProjectSelectionPayload',
    'ProjectSelectionResponse',
]

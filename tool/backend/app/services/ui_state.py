"""Manage UI interaction state shared across requests."""

from __future__ import annotations

from threading import Lock
from typing import Literal

InteractionMode = Literal['explore', 'edit']

_DEFAULT_MODE: InteractionMode = 'explore'
_VALID_MODES = {'explore', 'edit'}

_state = {'interaction_mode': _DEFAULT_MODE, 'active_project': None}
_lock = Lock()


def _normalize_mode(mode: str | None) -> InteractionMode:
    if mode is None:
        raise ValueError('Interaction mode is required.')
    normalized = str(mode).strip().lower()
    if normalized not in _VALID_MODES:
        raise ValueError('Interaction mode must be "explore" or "edit".')
    return normalized  # type: ignore[return-value]


def get_interaction_mode() -> InteractionMode:
    """Gets current interaction mode."""

    with _lock:
        return _state['interaction_mode']  # type: ignore[return-value]


def set_interaction_mode(mode: str | None) -> InteractionMode:
    """Update and return the active interaction mode."""

    normalized = _normalize_mode(mode)
    with _lock:
        _state['interaction_mode'] = normalized
        return normalized


def reset_interaction_mode() -> InteractionMode:
    """Reset the interaction mode back to the default value."""

    with _lock:
        _state['interaction_mode'] = _DEFAULT_MODE
        return _DEFAULT_MODE


def _normalize_project_name(name: str | None) -> str:
    if name is None:
        raise ValueError('Project name is required.')
    normalized = str(name).strip()
    if not normalized:
        raise ValueError('Project name must be a non-empty string.')
    return normalized


def get_active_project() -> str | None:
    """Gets last active project name."""

    with _lock:
        stored = _state.get('active_project')
        if stored is None:
            return None
        return str(stored)


def set_active_project(name: str | None) -> str | None:
    """Saves active project name."""

    with _lock:
        if name is None:
            _state['active_project'] = None
            return None
    normalized = _normalize_project_name(name)
    with _lock:
        _state['active_project'] = normalized
        return normalized


def reset_active_project() -> None:
    """Clear any stored active project selection."""

    with _lock:
        _state['active_project'] = None


__all__ = [
    'get_interaction_mode',
    'set_interaction_mode',
    'reset_interaction_mode',
    'get_active_project',
    'set_active_project',
    'reset_active_project',
]

"""Pydantic models describing project visibility settings."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Set, Tuple

from pydantic import BaseModel, Field, validator


class ProjectCreateRequest(BaseModel):
    """Payload describing the data required to create a project."""

    name: str
    description: str

    @validator("name")
    def _normalize_name(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure project names are safe and use the NPZ extension."""

        trimmed = str(value or "").strip()
        if not trimmed:
            raise ValueError("Project name cannot be empty")

        safe_name = Path(trimmed).name.strip()
        safe_name = safe_name.replace(":", "")
        if not safe_name:
            raise ValueError("Project name cannot be empty")

        if not safe_name.lower().endswith(".npz"):
            safe_name = f"{safe_name}.npz"

        if not Path(safe_name).stem.strip():
            raise ValueError("Project name cannot be empty")

        return safe_name

    @validator("description")
    def _normalize_description(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure the project description is a non-empty string."""

        text = str(value or "").strip()
        if not text:
            raise ValueError("Project description cannot be empty")
        return text

    class Config:
        extra = "ignore"


class ArrayVisibility(BaseModel):
    """Visibility configuration for a single array."""

    enabled: bool = True
    disabled_columns: List[int] = Field(default_factory=list)

    @validator("disabled_columns", pre=True)
    def _coerce_disabled_columns(cls, value):  # noqa: D401 - pydantic validator signature
        """Normalize collections of indices into a sorted list."""

        if value is None:
            return []

        if isinstance(value, (list, tuple, set)):
            normalized: Set[int] = set()
            for item in value:
                try:
                    number = int(item)
                except (TypeError, ValueError):
                    continue
                if number < 0:
                    continue
                normalized.add(number)
            return sorted(normalized)

        raise TypeError("disabled_columns must be a collection of integers")

    class Config:
        extra = "ignore"


class ProjectVisibility(BaseModel):
    """Visibility configuration for all arrays within a project."""

    arrays: Dict[str, ArrayVisibility] = Field(default_factory=dict)

    def normalized(self, valid_arrays: Iterable[str]) -> Dict[str, object]:
        """Filters to known arrays only."""

        allowed = {str(name) for name in valid_arrays}
        normalized: Dict[str, Dict[str, object]] = {}

        for name, config in self.arrays.items():
            if name not in allowed:
                continue
            payload = config.dict()
            enabled = bool(payload.get("enabled", True))
            disabled_columns = payload.get("disabled_columns", [])
            if enabled and not disabled_columns:
                # Skip default-visible arrays
                continue
            normalized[name] = {
                "enabled": enabled,
                "disabled_columns": list(disabled_columns),
            }

        return {"arrays": normalized}

    class Config:
        extra = "ignore"


class TimeAxisConfig(BaseModel):
    """Configuration describing the selected time axis for a project."""

    array_id: Optional[str] = Field(default=None)
    array_name: Optional[str] = Field(default=None)
    source: Optional[str] = Field(default=None)

    @validator("array_id", "array_name", pre=True)
    def _normalize_text(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure optional textual fields are stored as trimmed strings."""

        if value is None:
            return None

        text = str(value).strip()
        return text or None

    @validator("source")
    def _validate_source(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure the time axis source is one of the supported values."""

        if value is None:
            return None

        text = str(value).strip().lower()
        if not text:
            return None

        allowed = {"auto", "manual", "unknown"}
        if text not in allowed:
            raise ValueError("source must be one of 'auto', 'manual', or 'unknown'")

        return text

    class Config:
        extra = "ignore"


class TimeControlsConfig(BaseModel):
    """Time control settings."""

    timesteps: Optional[int] = Field(default=None, ge=1)
    analysis_scope: Optional[str] = None
    recording_duration: Optional[float] = Field(default=None, ge=0)
    playback_speed: Optional[float] = Field(default=None, gt=0)
    playback_original_speed: Optional[bool] = None

    @validator("timesteps", pre=True)
    def _normalize_timesteps(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure timesteps are stored as positive integers."""

        if value is None:
            return None

        if isinstance(value, bool):
            raise TypeError("timesteps must be a positive integer")

        if isinstance(value, (int, float)):
            number = int(value)
        else:
            text = str(value).strip()
            if not text:
                return None
            try:
                number = int(text)
            except ValueError as exc:
                raise TypeError("timesteps must be a positive integer") from exc

        if number <= 0:
            raise ValueError("timesteps must be greater than zero")

        return number

    @validator("analysis_scope", pre=True)
    def _normalize_analysis_scope(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure the analysis scope flag is canonical."""

        if value is None:
            return None

        text = str(value).strip().lower()
        if not text:
            return None

        if text not in {"all", "matching"}:
            raise ValueError("analysis_scope must be 'all' or 'matching'")

        return text

    @validator("recording_duration", pre=True)
    def _normalize_recording_duration(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure the recording duration is a non-negative number."""

        if value is None:
            return None

        if isinstance(value, bool):
            raise TypeError("recording_duration must be a non-negative number")

        if isinstance(value, (int, float)):
            number = float(value)
        else:
            text = str(value).strip()
            if not text:
                return None
            try:
                number = float(text)
            except ValueError as exc:
                raise TypeError("recording_duration must be a non-negative number") from exc

        if number < 0:
            raise ValueError("recording_duration must be greater than or equal to zero")

        return number

    @validator("playback_speed", pre=True)
    def _normalize_playback_speed(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure the playback speed is a positive number."""

        if value is None:
            return None

        if isinstance(value, bool):
            raise TypeError("playback_speed must be a positive number")

        if isinstance(value, (int, float)):
            number = float(value)
        else:
            text = str(value).strip()
            if not text:
                return None
            try:
                number = float(text)
            except ValueError as exc:
                raise TypeError("playback_speed must be a positive number") from exc

        if number <= 0:
            raise ValueError("playback_speed must be greater than zero")

        return number

    @validator("playback_original_speed", pre=True)
    def _normalize_playback_original_speed(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure the real-time playback flag is boolean when provided."""

        if value is None:
            return None

        if isinstance(value, bool):
            return value

        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if value == 0:
                return False
            if value == 1:
                return True
            raise ValueError("playback_original_speed must be true or false")

        if isinstance(value, str):
            text = value.strip().lower()
            if not text:
                return None
            if text in {"true", "1", "yes", "on"}:
                return True
            if text in {"false", "0", "no", "off"}:
                return False
            raise ValueError("playback_original_speed must be true or false")

        raise TypeError("playback_original_speed must be true or false")

    class Config:
        extra = "ignore"


class ArrayUpdateRequest(BaseModel):
    """Payload describing updates to a project array."""

    name: Optional[str] = None
    column_names: Optional[Dict[int, str]] = None

    @validator("name")
    def _normalize_name(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure array names are non-empty and safe."""

        if value is None:
            return value

        trimmed = str(value).strip()
        if not trimmed:
            raise ValueError("Array name cannot be empty")

        sanitized = trimmed.replace("\\", "/").split("/")[-1].strip()
        if not sanitized:
            raise ValueError("Array name cannot be empty")

        return sanitized

    @validator("column_names", pre=True)
    def _normalize_column_names(cls, value):  # noqa: D401 - pydantic validator signature
        """Normalize incoming column name collections into a mapping."""

        if value is None:
            return None

        if isinstance(value, str):
            parts = [part.strip() for part in value.split(",")]
            value = list(filter(None, parts))

        items: Iterable[Tuple[int, object]]
        if isinstance(value, dict):
            items = value.items()
        elif isinstance(value, (list, tuple, set)):
            items = enumerate(value, start=1)
        else:
            raise TypeError("column_names must be provided as a list or mapping")

        normalized: Dict[int, str] = {}
        for raw_index, raw_value in items:
            try:
                index = int(raw_index)
            except (TypeError, ValueError):
                continue
            if index < 1:
                continue
            text = str(raw_value).strip()
            if not text:
                continue
            normalized[index] = text
            if len(normalized) >= 1024:
                break

        return dict(sorted(normalized.items()))

    class Config:
        extra = "ignore"


class ProjectUpdateRequest(BaseModel):
    """Payload describing updates for a project."""

    name: Optional[str] = None
    visibility: Optional[ProjectVisibility] = None
    time_axis: Optional[TimeAxisConfig] = None
    time_controls: Optional[TimeControlsConfig] = None
    subject_mode: Optional[str] = None
    subject_arrays: Optional[List[str]] = None
    subject_names: Optional[Dict[str, str]] = None

    @validator("name")
    def _normalize_name(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure project names are safe and use the NPZ extension."""

        if value is None:
            return value

        trimmed = str(value).strip()
        if not trimmed:
            raise ValueError("Project name cannot be empty")

        safe_name = Path(trimmed).name.strip()
        safe_name = safe_name.replace(":", "")
        if not safe_name:
            raise ValueError("Project name cannot be empty")

        if not safe_name.lower().endswith(".npz"):
            safe_name = f"{safe_name}.npz"

        return safe_name

    @validator("subject_mode", pre=True)
    def _normalize_subject_mode(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure the subject mode flag is either 'single' or 'multi'."""

        if value is None:
            return None

        text = str(value).strip().lower()
        if not text:
            return None

        if text in {"single", "single-subject"}:
            return "single"

        if text in {"multi", "multi-subject", "multiple", "multiple-subjects"}:
            return "multi"

        normalized = text.replace("_", " ").replace("-", " ")
        normalized = " ".join(normalized.split())
        if normalized in {"single subject"}:
            return "single"
        if normalized in {"multi subject", "multiple subjects"}:
            return "multi"

        raise ValueError("subject_mode must be 'single' or 'multi'")

    @validator("subject_arrays", pre=True)
    def _normalize_subject_arrays(cls, value):  # noqa: D401 - pydantic validator signature
        """Ensure subject array identifiers are provided as a list of strings."""

        if value is None:
            return None

        if isinstance(value, (str, bytes)):
            items = [value]
        else:
            try:
                items = list(value)
            except TypeError as exc:
                raise ValueError("subject_arrays must be an iterable of identifiers") from exc

        normalized: List[str] = []
        seen: Set[str] = set()
        for item in items:
            text = str(item or "").strip()
            if not text or text in seen:
                continue
            seen.add(text)
            normalized.append(text)

        return normalized

    @validator("subject_names", pre=True)
    def _normalize_subject_names(cls, value):  # noqa: D401 - pydantic validator signature
        """Normalize subject name mappings into trimmed string pairs."""

        if value is None:
            return None

        if isinstance(value, Mapping):
            items = value.items()
        else:
            try:
                items = dict(value).items()
            except Exception as exc:
                raise ValueError("subject_names must be a mapping of identifiers to labels") from exc

        normalized: Dict[str, str] = {}
        for raw_key, raw_value in items:
            key = str(raw_key or "").strip()
            if not key:
                continue
            text = str(raw_value or "").strip()
            if not text:
                continue
            normalized[key] = text
            if len(normalized) >= 1024:
                break

        return normalized

    class Config:
        extra = "ignore"

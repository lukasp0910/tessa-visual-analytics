"""Shared helpers for service modules."""

from __future__ import annotations

from typing import Dict, Iterable, Mapping, Optional

import numpy as np


def normalize_column_name_map(
    values: Optional[Mapping[int, str] | Iterable[object] | str],
    limit: Optional[int] = None,
) -> Dict[int, str]:
    """Sanitize a collection of column name overrides."""

    if values is None:
        return {}

    if isinstance(values, str):
        items = enumerate(values.split(","), start=1)
    elif isinstance(values, dict):
        items = values.items()
    elif isinstance(values, (list, tuple, set)):
        items = enumerate(values, start=1)
    else:
        return {}

    normalized: Dict[int, str] = {}
    for raw_index, raw_value in items:
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            continue
        if index < 1:
            continue
        if limit is not None and index > limit:
            continue
        text = str(raw_value).strip()
        if not text:
            continue
        normalized[index] = text
        if len(normalized) >= 1024:
            break

    return dict(sorted(normalized.items()))


def column_count(array: np.ndarray) -> int:
    """Gets flattened column count."""

    if array.ndim == 0:
        return 1

    if array.ndim == 1:
        return 1

    try:
        count = int(np.prod(array.shape[1:]))
    except (TypeError, ValueError):
        count = 1

    return max(count, 0)


__all__ = ["normalize_column_name_map", "column_count"]


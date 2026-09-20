"""Progress tracking service for long-running operations like PCA computation."""

from __future__ import annotations

import logging
import threading
import time
from typing import Dict, Optional

LOGGER = logging.getLogger(__name__)

# Thread-safe progress storage
_progress_lock = threading.RLock()
_progress_store: Dict[str, Dict[str, object]] = {}


def update_progress(
    job_id: str,
    percentage: int,
    message: Optional[str] = None,
    status: str = "running",
) -> None:
    """Update progress for a job.

    Parameters
    ----------
    job_id:
        Unique identifier for the job.
    percentage:
        Progress percentage (0-100).
    message:
        Optional progress message.
    status:
        Job status ('running', 'completed', 'error').
    """
    if not isinstance(job_id, str) or not job_id.strip():
        raise ValueError("job_id must be a non-empty string")

    percentage = max(0, min(100, int(percentage)))
    
    with _progress_lock:
        _progress_store[job_id] = {
            "percentage": percentage,
            "status": status,
            "message": message or f"Processing: {percentage}%",
            "timestamp": time.time(),
        }
    
    LOGGER.debug(
        "Progress update",
        extra={
            "job_id": job_id,
            "percentage": percentage,
            "status": status,
            "message": message,
        },
    )


def get_progress(job_id: str) -> Optional[Dict[str, object]]:
    """Get current progress for a job.

    Parameters
    ----------
    job_id:
        Unique identifier for the job.

    Returns
    -------
    Progress dict with 'percentage', 'status', 'message', 'timestamp', or None if not found.
    """
    if not isinstance(job_id, str) or not job_id.strip():
        return None
    
    with _progress_lock:
        return _progress_store.get(job_id)


def clear_progress(job_id: str) -> None:
    """Remove progress tracking for a completed job.

    Parameters
    ----------
    job_id:
        Unique identifier for the job.
    """
    if not isinstance(job_id, str) or not job_id.strip():
        return
    
    with _progress_lock:
        _progress_store.pop(job_id, None)
    
    LOGGER.debug("Cleared progress", extra={"job_id": job_id})


def cleanup_stale_progress(max_age_seconds: float = 3600) -> int:
    """Remove progress entries older than max_age_seconds.

    Parameters
    ----------
    max_age_seconds:
        Maximum age in seconds before an entry is considered stale.

    Returns
    -------
    Number of entries removed.
    """
    current_time = time.time()
    removed_count = 0
    
    with _progress_lock:
        stale_keys = [
            job_id
            for job_id, data in _progress_store.items()
            if isinstance(data, dict)
            and current_time - data.get("timestamp", 0) > max_age_seconds
        ]
        for job_id in stale_keys:
            _progress_store.pop(job_id, None)
            removed_count += 1
    
    if removed_count > 0:
        LOGGER.info(f"Cleaned up {removed_count} stale progress entries")
    
    return removed_count


__all__ = ["update_progress", "get_progress", "clear_progress", "cleanup_stale_progress"]

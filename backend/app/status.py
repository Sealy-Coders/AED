"""Real-time AED open/closed status based on Europe/Warsaw local time."""

from __future__ import annotations

from datetime import datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from app.models import OpenStatus

WARSAW = ZoneInfo("Europe/Warsaw")

_LABELS = {
    "open_24_7": "Czynne 24/7",
    "open_now": "Otwarte teraz",
    "closed_now": "Zamknięte teraz",
    "unknown": "Nieznany status",
}


def _parse_hhmm(value: str) -> time | None:
    try:
        parts = value.strip().split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
        return time(hour=hour, minute=minute)
    except (AttributeError, TypeError, ValueError, IndexError):
        return None


def _is_within_hours(
    now: datetime,
    opening_hours: dict[str, Any],
) -> bool | None:
    """
    Return True/False if hours can be evaluated, or None if incomplete/invalid.

    Days use Python weekday(): Monday=0 … Sunday=6.
    Time window is half-open [start, end).
    """
    days = opening_hours.get("days")
    start_raw = opening_hours.get("start")
    end_raw = opening_hours.get("end")
    if not isinstance(days, list) or start_raw is None or end_raw is None:
        return None

    start_t = _parse_hhmm(str(start_raw))
    end_t = _parse_hhmm(str(end_raw))
    if start_t is None or end_t is None:
        return None

    try:
        day_set = {int(d) for d in days}
    except (TypeError, ValueError):
        return None

    if now.weekday() not in day_set:
        return False

    now_t = now.timetz().replace(tzinfo=None)
    if start_t <= end_t:
        return start_t <= now_t < end_t
    # Overnight window (e.g. 22:00–06:00)
    return now_t >= start_t or now_t < end_t


def compute_open_status(
    aed: dict[str, Any],
    *,
    now: datetime | None = None,
) -> OpenStatus:
    """Compute live availability status for a single AED record."""
    if now is None:
        now = datetime.now(WARSAW)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=WARSAW)
    else:
        now = now.astimezone(WARSAW)

    if aed.get("is_24_7"):
        key = "open_24_7"
        return OpenStatus(key=key, label=_LABELS[key], badge=key)

    hours = aed.get("opening_hours_simple")
    if isinstance(hours, dict):
        within = _is_within_hours(now, hours)
        if within is True:
            key = "open_now"
            return OpenStatus(key=key, label=_LABELS[key], badge=key)
        if within is False:
            key = "closed_now"
            return OpenStatus(key=key, label=_LABELS[key], badge=key)

    key = "unknown"
    return OpenStatus(key=key, label=_LABELS[key], badge=key)


def is_open_now_status(status: OpenStatus) -> bool:
    """Whether status counts as open for only_open_now filtering."""
    return status.key in ("open_24_7", "open_now")

"""Real-time AED open/closed status based on Europe/Warsaw local time."""

from datetime import datetime, time
from typing import Any, Dict, Optional

import pytz

WARSAW = pytz.timezone("Europe/Warsaw")

OPEN_24_7 = "open_24_7"
OPEN_NOW = "open_now"
CLOSED_NOW = "closed_now"
UNKNOWN = "unknown"

LABELS = {
    OPEN_24_7: "Czynne 24/7",
    OPEN_NOW: "Otwarte teraz",
    CLOSED_NOW: "Zamknięte teraz",
    UNKNOWN: "Nieznany status",
}


def _parse_hhmm(value: str) -> Optional[time]:
    try:
        parts = value.strip().split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
        return time(hour=hour, minute=minute)
    except (AttributeError, TypeError, ValueError, IndexError):
        return None


def _is_within_hours(now: datetime, opening_hours: Dict[str, Any]) -> Optional[bool]:
    """
    True/False if the hours can be evaluated, None if incomplete/invalid.

    Days use ``weekday()`` (Monday=0 … Sunday=6); the time window is half-open [start, end).
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
    # Overnight window (e.g. 22:00-06:00)
    return now_t >= start_t or now_t < end_t


def to_warsaw(now: Optional[datetime] = None) -> datetime:
    if now is None:
        return datetime.now(WARSAW)
    if now.tzinfo is None:
        return WARSAW.localize(now)
    return now.astimezone(WARSAW)


def compute_open_status(
    is_24_7: bool,
    opening_hours_simple: Optional[Dict[str, Any]],
    now: Optional[datetime] = None,
) -> Dict[str, str]:
    """Live availability status: ``{"key", "label", "badge"}``."""
    if is_24_7:
        key = OPEN_24_7
    elif isinstance(opening_hours_simple, dict):
        within = _is_within_hours(to_warsaw(now), opening_hours_simple)
        key = OPEN_NOW if within is True else CLOSED_NOW if within is False else UNKNOWN
    else:
        key = UNKNOWN
    return {"key": key, "label": LABELS[key], "badge": key}


def is_open(status: Dict[str, str]) -> bool:
    """Whether a status counts as open for the ``only_open_now`` filter."""
    return status["key"] in (OPEN_24_7, OPEN_NOW)

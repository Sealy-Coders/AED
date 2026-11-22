"""AedDevice -> API contract used by the frontend AED map."""

from datetime import datetime
from typing import Any, Dict, Iterable, Optional, Tuple

from mcod.aed.opening_hours import parse_opening_hours
from mcod.aed.status import compute_open_status

# scraper uses "nieznane" as a sentinel for missing hours
UNKNOWN_HOURS = "nieznane"
DEFAULT_NAME = "Defibrylator AED"


def _display_address(address: Optional[str], city: Optional[str]) -> Optional[str]:
    if address and city and city.lower() not in address.lower():
        return f"{address}, {city}"
    return address or city


def serialize_aed(device, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Maps one ``AedDevice`` to an ``/aed`` item (with live open status)."""
    raw_hours = None if device.opening_hours in (None, UNKNOWN_HOURS) else device.opening_hours
    is_24_7, hours_simple = parse_opening_hours(raw_hours)
    return {
        "id": device.id,
        "name": device.operator or device.location_description or DEFAULT_NAME,
        "lat": device.latitude,
        "lon": device.longitude,
        "teryt_gmina": device.teryt_gmina,
        "gmina_name": device.gmina_name,
        "address": _display_address(device.address, device.city),
        "city": device.city,
        "location_detail": device.location_description,
        # Not provided by any of the scraped sources:
        "placement": None,
        "cabinet": None,
        "access_note": None,
        "pediatric_mode": None,
        "last_verified": None,
        "locked": bool(device.locked),
        "is_24_7": is_24_7,
        "opening_hours_simple": hours_simple,
        "opening_hours_raw": raw_hours,
        "operator": device.operator,
        "source": device.source,
        "status": compute_open_status(is_24_7, hours_simple, now=now),
    }


def rollup_counts(commune_counts: Iterable[Tuple[Optional[str], int]]) -> Dict[str, Any]:
    """
    Aggregates gmina counts (7-digit TERYT) up to powiat (4) and województwo (2)
    for ``GET /aed/frequencies``.
    """
    communes: Dict[str, int] = {}
    counties: Dict[str, int] = {}
    voivodeships: Dict[str, int] = {}
    unassigned = 0
    for code, count in commune_counts:
        if not code:
            unassigned += count
            continue
        communes[code] = communes.get(code, 0) + count
        counties[code[:4]] = counties.get(code[:4], 0) + count
        voivodeships[code[:2]] = voivodeships.get(code[:2], 0) + count
    return {
        "voivodeships": voivodeships,
        "counties": counties,
        "communes": communes,
        "total": sum(communes.values()) + unassigned,
        "unassigned": unassigned,
    }

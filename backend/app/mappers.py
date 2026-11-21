"""DTO layer: MongoDB documents (scraper4 shape) -> API contract.

scraper4.py produces records with `latitude`/`longitude`, `location_description`,
an OSM-style `opening_hours` string and a `locked` flag. The API contract (and
`status.compute_open_status`) expects `lat`/`lon`, `location_detail`, `is_24_7`
and `opening_hours_simple`. This module bridges the two.
"""

from __future__ import annotations

import re
from typing import Any

_DAY_CODES = ("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su")  # weekday() order
_ALL_DAYS = list(range(7))

_RULE_RE = re.compile(
    r"^(?:(?P<days>[A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)\s+)?"
    r"(?P<start>\d{1,2}:\d{2})\s*-\s*(?P<end>\d{1,2}:\d{2})$"
)


def _parse_days(spec: str | None) -> list[int] | None:
    if not spec:
        return _ALL_DAYS
    days: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            first, last = (p.strip().title() for p in part.split("-", 1))
            if first not in _DAY_CODES or last not in _DAY_CODES:
                return None
            i, j = _DAY_CODES.index(first), _DAY_CODES.index(last)
            span = range(i, j + 1) if i <= j else [*range(i, 7), *range(0, j + 1)]
            days.update(span)
        else:
            code = part.title()
            if code not in _DAY_CODES:
                return None
            days.add(_DAY_CODES.index(code))
    return sorted(days)


def parse_opening_hours(raw: str | None) -> tuple[bool, dict[str, Any] | None]:
    """
    Parse a (subset of) OSM `opening_hours` string.

    Returns (is_24_7, opening_hours_simple). Only "24/7" and a single
    "<days> HH:MM-HH:MM" rule are understood; anything else -> (False, None),
    which the status module reports as "unknown".
    """
    if not raw:
        return False, None
    text = raw.strip()
    if text.lower() in ("24/7", "24h", "całodobowo", "calodobowo"):
        return True, None

    # "…; Sa-Su, PH off" only restates closed days -> drop such rules.
    # (Public holidays are not modelled, so "PH off" is ignored.)
    open_rules = [
        rule.strip()
        for rule in text.split(";")
        if rule.strip() and not re.search(r"\b(off|closed)$", rule.strip(), re.I)
    ]
    if len(open_rules) != 1:
        return False, None

    match = _RULE_RE.match(open_rules[0])
    if not match:
        return False, None
    days = _parse_days(match.group("days"))
    if days is None:
        return False, None

    start, end = match.group("start").zfill(5), match.group("end").zfill(5)
    if end == "24:00":
        if start == "00:00":
            if days == _ALL_DAYS:
                return True, None
            end = "23:59"
        else:
            end = "00:00"  # handled as an overnight window by status.py
    return False, {"days": days, "start": start, "end": end}


def _display_address(address: str | None, city: str | None) -> str | None:
    if address and city and city.lower() not in address.lower():
        return f"{address}, {city}"
    return address or city


def to_api_aed(doc: dict[str, Any]) -> dict[str, Any]:
    """Map one MongoDB document to the `/api/aed` item contract."""
    is_24_7, hours_simple = parse_opening_hours(doc.get("opening_hours"))
    operator = doc.get("operator")
    return {
        "id": str(doc["_id"]),
        "name": operator or doc.get("location_description") or "Defibrylator AED",
        "lat": doc.get("latitude"),
        "lon": doc.get("longitude"),
        "teryt_gmina": doc.get("teryt_gmina"),
        "gmina_name": doc.get("gmina_name"),
        "address": _display_address(doc.get("address"), doc.get("city")),
        "city": doc.get("city"),
        "location_detail": doc.get("location_description"),
        # Not provided by any scraper source:
        "placement": None,
        "cabinet": None,
        "access_note": None,
        "pediatric_mode": None,
        "last_verified": None,
        "locked": bool(doc.get("locked")),
        "is_24_7": is_24_7,
        "opening_hours_simple": hours_simple,
        # scraper4 uses "nieznane" as a sentinel for missing hours
        "opening_hours_raw": None
        if doc.get("opening_hours") in (None, "nieznane")
        else doc.get("opening_hours"),
        "operator": operator,
        "source": doc.get("source"),
    }


def rollup_counts(commune_counts: dict[str, int]) -> dict[str, dict[str, int]]:
    """
    Aggregate gmina counts (7-digit TERYT) up to powiat (4) and województwo (2),
    matching the frontend `DefibrillatorData` shape.
    """
    counties: dict[str, int] = {}
    voivodeships: dict[str, int] = {}
    for code, count in commune_counts.items():
        counties[code[:4]] = counties.get(code[:4], 0) + count
        voivodeships[code[:2]] = voivodeships.get(code[:2], 0) + count
    return {
        "voivodeships": voivodeships,
        "counties": counties,
        "communes": dict(commune_counts),
    }

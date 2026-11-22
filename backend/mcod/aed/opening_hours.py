"""Parsing of (a subset of) the OSM ``opening_hours`` syntax used by AED sources."""

import re
from typing import Any, Dict, List, Optional, Tuple

DAY_CODES = ("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su")  # datetime.weekday() order
ALL_DAYS = list(range(7))

_RULE_RE = re.compile(
    r"^(?:(?P<days>[A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)\s+)?" r"(?P<start>\d{1,2}:\d{2})\s*-\s*(?P<end>\d{1,2}:\d{2})$"
)

ALWAYS_OPEN = ("24/7", "24h", "całodobowo", "calodobowo")


def _parse_days(spec: Optional[str]) -> Optional[List[int]]:
    if not spec:
        return ALL_DAYS
    days = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            first, last = (p.strip().title() for p in part.split("-", 1))
            if first not in DAY_CODES or last not in DAY_CODES:
                return None
            i, j = DAY_CODES.index(first), DAY_CODES.index(last)
            span = range(i, j + 1) if i <= j else [*range(i, 7), *range(0, j + 1)]
            days.update(span)
        else:
            code = part.title()
            if code not in DAY_CODES:
                return None
            days.add(DAY_CODES.index(code))
    return sorted(days)


def parse_opening_hours(raw: Optional[str]) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """
    Returns ``(is_24_7, opening_hours_simple)``.

    Only ``24/7`` and a single ``<days> HH:MM-HH:MM`` rule are understood; anything
    else gives ``(False, None)``, reported by the status module as "unknown".
    """
    if not raw:
        return False, None
    text = raw.strip()
    if text.lower() in ALWAYS_OPEN:
        return True, None

    # "…; Sa-Su, PH off" only restates closed days -> drop such rules.
    # (Public holidays are not modelled, so "PH off" is ignored.)
    open_rules = [
        rule.strip() for rule in text.split(";") if rule.strip() and not re.search(r"\b(off|closed)$", rule.strip(), re.I)
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
            if days == ALL_DAYS:
                return True, None
            end = "23:59"
        else:
            end = "00:00"  # handled as an overnight window by mcod.aed.status
    return False, {"days": days, "start": start, "end": end}

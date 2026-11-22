from datetime import datetime

import pytest

from mcod.aed.etl import deduplicate, record_id, validate
from mcod.aed.geo import GminaLocator
from mcod.aed.opening_hours import parse_opening_hours
from mcod.aed.serializers import rollup_counts
from mcod.aed.status import WARSAW, compute_open_status

# 2026-11-23 is a Monday
MONDAY_NOON = WARSAW.localize(datetime(2026, 11, 23, 12, 0))
MONDAY_23H = WARSAW.localize(datetime(2026, 11, 23, 23, 0))
SUNDAY_NOON = WARSAW.localize(datetime(2026, 11, 29, 12, 0))


@pytest.mark.parametrize(
    "raw, expected",
    [
        (None, (False, None)),
        ("24/7", (True, None)),
        ("całodobowo", (True, None)),
        ("Mo-Su 00:00-24:00", (True, None)),
        ("Mo-Fr 08:00-16:00", (False, {"days": [0, 1, 2, 3, 4], "start": "08:00", "end": "16:00"})),
        ("Mo-Fr 8:00-16:00; Sa-Su off", (False, {"days": [0, 1, 2, 3, 4], "start": "08:00", "end": "16:00"})),
        ("Fr-Mo 10:00-12:00", (False, {"days": [0, 4, 5, 6], "start": "10:00", "end": "12:00"})),
        ("Mo-Sa 22:00-24:00", (False, {"days": [0, 1, 2, 3, 4, 5], "start": "22:00", "end": "00:00"})),
        ("Mo-Fr 08:00-12:00; Sa 10:00-14:00", (False, None)),
        ("by appointment", (False, None)),
    ],
)
def test_parse_opening_hours(raw, expected):
    assert parse_opening_hours(raw) == expected


def test_status_24_7():
    assert compute_open_status(True, None, now=MONDAY_NOON)["key"] == "open_24_7"


def test_status_open_closed_unknown():
    weekdays = {"days": [0, 1, 2, 3, 4], "start": "08:00", "end": "16:00"}
    assert compute_open_status(False, weekdays, now=MONDAY_NOON)["key"] == "open_now"
    assert compute_open_status(False, weekdays, now=SUNDAY_NOON)["key"] == "closed_now"
    assert compute_open_status(False, None, now=MONDAY_NOON)["key"] == "unknown"


def test_status_overnight_window():
    overnight = {"days": [0], "start": "22:00", "end": "06:00"}
    assert compute_open_status(False, overnight, now=MONDAY_23H)["key"] == "open_now"
    assert compute_open_status(False, overnight, now=MONDAY_NOON)["key"] == "closed_now"


def test_status_naive_datetime_is_warsaw_time():
    weekdays = {"days": [0], "start": "11:00", "end": "13:00"}
    assert compute_open_status(False, weekdays, now=datetime(2026, 11, 23, 12, 0))["key"] == "open_now"


def test_validate_rejects_bad_records():
    valid, rejected = validate(
        [
            {"latitude": "52,2297", "longitude": 21.0122, "source": "OSM", "city": "  Warszawa "},
            {"latitude": None, "longitude": 21.0},
            {"latitude": 48.0, "longitude": 21.0},
            "not a dict",
        ]
    )
    assert len(valid) == 1
    assert valid[0]["latitude"] == pytest.approx(52.2297)
    assert valid[0]["city"] == "Warszawa"
    assert valid[0]["locked"] is False
    assert rejected == {"missing_coordinates": 1, "outside_poland_bbox": 1, "not_an_object": 1}


def test_deduplicate_merges_nearby_points_and_ids_are_deterministic():
    records = [
        {"latitude": 52.22970, "longitude": 21.01220, "source": "A", "opening_hours": "nieznane"},
        # ~5 m away -> merged into the first record
        {"latitude": 52.22974, "longitude": 21.01224, "source": "B", "opening_hours": "24/7", "city": "Warszawa"},
        {"latitude": 50.06143, "longitude": 19.93658, "source": "C"},
    ]
    unique = deduplicate(records)
    assert len(unique) == 2
    first = unique[0]
    assert first["id"] == record_id(52.22970, 21.01220)
    assert first["source"] == "A + B"
    assert first["city"] == "Warszawa"
    assert first["opening_hours"] == "24/7"


def _square(code, name, x0, y0, size=1.0, hole=None):
    rings = [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]]
    if hole:
        rings.append(hole)
    return {
        "type": "Feature",
        "properties": {"JPT_KOD_JE": code, "JPT_NAZWA_": name},
        "geometry": {"type": "Polygon", "coordinates": rings},
    }


def test_gmina_locator():
    hole = [[20.4, 52.4], [20.6, 52.4], [20.6, 52.6], [20.4, 52.6], [20.4, 52.4]]
    locator = GminaLocator(
        [
            _square("1465011", "Warszawa", 20.0, 52.0, hole=hole),
            _square("1201011", "Inna", 21.0, 52.0),
        ]
    )
    assert len(locator) == 2
    assert locator.locate(52.2, 20.2) == ("1465011", "Warszawa")
    assert locator.locate(52.2, 21.5) == ("1201011", "Inna")
    # inside the hole of the first polygon
    assert locator.locate(52.5, 20.5) == (None, None)
    # just outside the border (< 0.02 deg) -> nearest gmina
    assert locator.locate(52.5, 19.99) == ("1465011", "Warszawa")
    assert locator.locate(54.9, 23.9) == (None, None)


def test_rollup_counts():
    result = rollup_counts([("1465011", 3), ("1465021", 2), ("1201011", 1), (None, 4)])
    assert result["communes"] == {"1465011": 3, "1465021": 2, "1201011": 1}
    assert result["counties"] == {"1465": 5, "1201": 1}
    assert result["voivodeships"] == {"14": 5, "12": 1}
    assert result["total"] == 10
    assert result["unassigned"] == 4

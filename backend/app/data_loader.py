"""Load gminy GeoJSON and AED JSON from disk, with mock fallbacks."""

from __future__ import annotations

import json
import logging
from copy import deepcopy
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
GMINE_PATH = DATA_DIR / "gminy_agg.geojson"
AED_PATH = DATA_DIR / "aed_clean.json"


def _mock_gminy() -> dict[str, Any]:
    """Minimal FeatureCollection for local demos without real data files."""
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [21.00, 52.20],
                            [21.10, 52.20],
                            [21.10, 52.28],
                            [21.00, 52.28],
                            [21.00, 52.20],
                        ]
                    ],
                },
                "properties": {
                    "teryt": "1465011",
                    "name": "Warszawa (mock)",
                    "aed_count": 42,
                    "area_km2": 517.2,
                    "population": 1862000,
                },
            },
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [19.90, 50.03],
                            [20.00, 50.03],
                            [20.00, 50.10],
                            [19.90, 50.10],
                            [19.90, 50.03],
                        ]
                    ],
                },
                "properties": {
                    "teryt": "1261011",
                    "name": "Kraków (mock)",
                    "aed_count": 18,
                    "area_km2": 326.8,
                    "population": 780000,
                },
            },
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [18.55, 54.32],
                            [18.70, 54.32],
                            [18.70, 54.42],
                            [18.55, 54.42],
                            [18.55, 54.32],
                        ]
                    ],
                },
                "properties": {
                    "teryt": "2261011",
                    "name": "Gdańsk (mock)",
                    "aed_count": 9,
                    "area_km2": 262.0,
                    "population": 470000,
                },
            },
        ],
    }


def _mock_aed() -> dict[str, Any]:
    """Minimal AED items covering 24/7, scheduled hours, and unknown status."""
    return {
        "items": [
            {
                "id": "aed-waw-001",
                "name": "AED Metro Centrum",
                "lat": 52.2297,
                "lon": 21.0122,
                "teryt_gmina": "1465011",
                "address": "ul. Marszałkowska 100, Warszawa",
                "location_detail": "Wejście od strony peronu",
                "placement": "indoor",
                "cabinet": "unlocked_alarm",
                "access_note": "Dostępny bez ograniczeń na stacji",
                "is_24_7": True,
                "opening_hours_simple": None,
                "pediatric_mode": True,
                "last_verified": "2026-01-15",
                "source": "mock",
            },
            {
                "id": "aed-waw-002",
                "name": "AED Urząd Dzielnicy",
                "lat": 52.2350,
                "lon": 21.0500,
                "teryt_gmina": "1465011",
                "address": "ul. Grochowska 274, Warszawa",
                "location_detail": "Hol główny",
                "placement": "indoor",
                "cabinet": "keypad_code",
                "access_note": "Kod u ochrony",
                "is_24_7": False,
                "opening_hours_simple": {
                    "days": [0, 1, 2, 3, 4],
                    "start": "08:00",
                    "end": "20:00",
                },
                "pediatric_mode": False,
                "last_verified": "2025-11-01",
                "source": "mock",
            },
            {
                "id": "aed-krk-001",
                "name": "AED Rynek Główny",
                "lat": 50.0614,
                "lon": 19.9373,
                "teryt_gmina": "1261011",
                "address": "Rynek Główny 1, Kraków",
                "location_detail": "Szafka na ścianie budynku",
                "placement": "outdoor",
                "cabinet": "unlocked_alarm",
                "access_note": None,
                "is_24_7": True,
                "opening_hours_simple": None,
                "pediatric_mode": True,
                "last_verified": "2026-02-01",
                "source": "mock",
            },
            {
                "id": "aed-gdn-001",
                "name": "AED Centrum Handlowe",
                "lat": 54.3520,
                "lon": 18.6466,
                "teryt_gmina": "2261011",
                "address": "ul. Grunwaldzka 141, Gdańsk",
                "location_detail": "Przy wejściu głównym",
                "placement": "indoor",
                "cabinet": "key_locked",
                "access_note": "Klucz u ochrony",
                "is_24_7": False,
                "opening_hours_simple": {
                    "days": [0, 1, 2, 3, 4, 5, 6],
                    "start": "10:00",
                    "end": "22:00",
                },
                "pediatric_mode": False,
                "last_verified": "2025-09-20",
                "source": "mock",
            },
            {
                "id": "aed-waw-003",
                "name": "AED Park Skaryszewski",
                "lat": 52.2420,
                "lon": 21.0550,
                "teryt_gmina": "1465011",
                "address": "Park Skaryszewski, Warszawa",
                "location_detail": "Przy alei głównej",
                "placement": "outdoor",
                "cabinet": "unlocked_alarm",
                "access_note": None,
                "is_24_7": False,
                "opening_hours_simple": None,
                "pediatric_mode": False,
                "last_verified": None,
                "source": "mock",
            },
        ]
    }


def _read_json(path: Path) -> Any | None:
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        logger.info("Data file not found: %s — using mock data", path)
        return None
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read %s (%s) — using mock data", path, exc)
        return None


def load_gminy() -> dict[str, Any]:
    """Load gminy FeatureCollection from disk or return mock data."""
    data = _read_json(GMINE_PATH)
    if data is None:
        return deepcopy(_mock_gminy())
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        logger.warning("Unexpected gminy schema — using mock data")
        return deepcopy(_mock_gminy())
    return data


def load_aed_items() -> list[dict[str, Any]]:
    """Load AED item list from disk or return mock data."""
    data = _read_json(AED_PATH)
    if data is None:
        return deepcopy(_mock_aed())["items"]
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return data["items"]
    if isinstance(data, list):
        return data
    logger.warning("Unexpected AED schema — using mock data")
    return deepcopy(_mock_aed())["items"]

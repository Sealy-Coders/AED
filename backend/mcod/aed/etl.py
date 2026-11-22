"""Validation, de-duplication and transformation of scraped AED records."""

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from mcod.aed.geo import GminaLocator
from mcod.aed.scraper import deduplicate_poland

# The same rectangle as in mcod.aed.scraper
LAT_RANGE = (49.0, 55.0)
LON_RANGE = (14.0, 24.5)

TEXT_FIELDS = (
    "city",
    "address",
    "location_description",
    "opening_hours",
    "operator",
    "source",
    "source_id",
)
# Column limits of mcod.aed.models.AedDevice
MAX_LENGTHS = {"city": 255, "opening_hours": 512, "source_id": 255}


def load_records(path: Path) -> List[Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("records"), list):
        return data["records"]
    if isinstance(data, list):
        return data
    raise ValueError(f"{path}: expected an object with a 'records' key (scraper result) or a list of records")


def _as_float(value: Any) -> Optional[float]:
    try:
        return float(str(value).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


def _as_text(value: Any, max_length: Optional[int] = None) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if max_length:
        text = text[:max_length]
    return text or None


def validate(records: List[Any]) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """Records with normalized types plus a counter of rejection reasons."""
    valid: List[Dict[str, Any]] = []
    rejected: Dict[str, int] = {}

    def reject(reason: str) -> None:
        rejected[reason] = rejected.get(reason, 0) + 1

    for raw in records:
        if not isinstance(raw, dict):
            reject("not_an_object")
            continue
        lat = _as_float(raw.get("latitude"))
        lon = _as_float(raw.get("longitude"))
        if lat is None or lon is None:
            reject("missing_coordinates")
            continue
        if not (LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]):
            reject("outside_poland_bbox")
            continue

        rec: Dict[str, Any] = {"latitude": lat, "longitude": lon}
        for field in TEXT_FIELDS:
            rec[field] = _as_text(raw.get(field), MAX_LENGTHS.get(field))
        rec["locked"] = bool(raw.get("locked"))
        rec["source"] = rec["source"] or "unknown"
        valid.append(rec)

    return valid, rejected


def record_id(lat: float, lon: float) -> str:
    """Deterministic id (~1 m precision) - keeps re-runs idempotent."""
    digest = hashlib.sha1(f"{lat:.5f},{lon:.5f}".encode()).hexdigest()[:16]
    return f"aed-{digest}"


def deduplicate(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # 1) the scraper's 15 m spatial merge - matters when the input joins several scrapes
    spatial = deduplicate_poland(records, radius_m=15.0)
    # 2) hard de-duplication on the deterministic id
    by_id: Dict[str, Dict[str, Any]] = {}
    for rec in spatial:
        rec_id = record_id(rec["latitude"], rec["longitude"])
        if rec_id not in by_id:
            by_id[rec_id] = {"id": rec_id, **rec}
    return list(by_id.values())


def assign_gminy(records: List[Dict[str, Any]], locator: GminaLocator) -> List[Dict[str, Any]]:
    for rec in records:
        rec["teryt_gmina"], rec["gmina_name"] = locator.locate(rec["latitude"], rec["longitude"])
    return records

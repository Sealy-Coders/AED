"""Load gminy geometry (GeoJSON) from disk. AED records live in MongoDB (see app.db)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)


def _empty_collection() -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": []}


def load_gminy(path: Path | None = None) -> dict[str, Any]:
    """
    Load the gminy FeatureCollection (geometry only) from GMINY_GEOJSON_PATH.

    Source files use `JPT_KOD_JE` / `JPT_NAZWA_`; they are exposed as `teryt` /
    `name` to keep the `/api/gminy` contract. `aed_count` is filled per request
    from MongoDB; `area_km2` / `population` are kept if the file provides them.
    """
    path = path or settings.gminy_geojson_path
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        logger.warning("Gminy GeoJSON not found: %s — /api/gminy will be empty", path)
        return _empty_collection()
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read %s (%s) — /api/gminy will be empty", path, exc)
        return _empty_collection()

    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        logger.warning("Unexpected gminy schema in %s — /api/gminy will be empty", path)
        return _empty_collection()

    for feature in data.get("features") or []:
        props = feature.setdefault("properties", {}) or {}
        feature["properties"] = props
        props.setdefault("teryt", props.get("JPT_KOD_JE"))
        props.setdefault("name", props.get("JPT_NAZWA_"))
    data.pop("meta", None)
    return data

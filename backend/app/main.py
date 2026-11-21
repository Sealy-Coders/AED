"""FastAPI application for the Polish AED map backend."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.data_loader import load_aed_items, load_gminy
from app.metrics import VALID_METRICS, enrich_gminy_with_metric
from app.models import AedListResponse, OpenStatus
from app.status import compute_open_status, is_open_now_status

# In-memory cache (loaded at import and refreshed on app startup)
_gminy: dict[str, Any] = load_gminy()
_aed_items: list[dict[str, Any]] = load_aed_items()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _gminy, _aed_items
    _gminy = load_gminy()
    _aed_items = load_aed_items()
    yield


app = FastAPI(
    title="AED Map API",
    description="Polish AED map and open-data aggregation backend",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in bbox.split(",")]
    if len(parts) != 4:
        raise HTTPException(
            status_code=400,
            detail="Invalid bbox: expected min_lon,min_lat,max_lon,max_lat",
        )
    try:
        min_lon, min_lat, max_lon, max_lat = (float(p) for p in parts)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail="Invalid bbox: all values must be numbers",
        ) from exc
    return min_lon, min_lat, max_lon, max_lat


def _in_bbox(
    lon: Any,
    lat: Any,
    bbox: tuple[float, float, float, float],
) -> bool:
    try:
        lon_f = float(lon)
        lat_f = float(lat)
    except (TypeError, ValueError):
        return False
    min_lon, min_lat, max_lon, max_lat = bbox
    return min_lon <= lon_f <= max_lon and min_lat <= lat_f <= max_lat


def _with_status(aed: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(aed)
    status: OpenStatus = compute_open_status(aed)
    enriched["status"] = status.model_dump()
    return enriched


def _ids_equal(left: Any, right: str) -> bool:
    return str(left) == right


@app.get("/api/gminy")
def get_gminy(
    metric: str = Query(
        default="aed_per_10k_pop",
        description="Choropleth metric: aed_count | aed_per_100km2 | aed_per_10k_pop",
    ),
) -> dict[str, Any]:
    if metric not in VALID_METRICS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid metric '{metric}'. "
                f"Allowed: {', '.join(sorted(VALID_METRICS))}"
            ),
        )
    return enrich_gminy_with_metric(_gminy, metric)  # type: ignore[arg-type]


@app.get("/api/aed", response_model=AedListResponse)
def list_aed(
    bbox: str | None = Query(
        default=None,
        description="Optional bbox: min_lon,min_lat,max_lon,max_lat",
    ),
    only_open_now: bool = Query(
        default=False,
        description="If true, return only AEDs open now (including 24/7)",
    ),
) -> AedListResponse:
    parsed_bbox: tuple[float, float, float, float] | None = None
    if bbox is not None and bbox.strip() != "":
        parsed_bbox = _parse_bbox(bbox)

    items: list[dict[str, Any]] = []
    for aed in _aed_items:
        if parsed_bbox is not None and not _in_bbox(
            aed.get("lon"), aed.get("lat"), parsed_bbox
        ):
            continue
        enriched = _with_status(aed)
        if only_open_now:
            status = OpenStatus.model_validate(enriched["status"])
            if not is_open_now_status(status):
                continue
        items.append(enriched)

    return AedListResponse(items=items, count=len(items))


@app.get("/api/aed/{aed_id}")
def get_aed(aed_id: str) -> dict[str, Any]:
    for aed in _aed_items:
        if _ids_equal(aed.get("id"), aed_id):
            return _with_status(aed)
    raise HTTPException(status_code=404, detail=f"AED '{aed_id}' not found")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}

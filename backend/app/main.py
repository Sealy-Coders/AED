"""FastAPI application for the Polish AED map backend."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pymongo.errors import PyMongoError

from app import db
from app.config import settings
from app.data_loader import load_gminy
from app.mappers import rollup_counts, to_api_aed
from app.metrics import VALID_METRICS, enrich_gminy_with_metric
from app.models import AedItem, AedListResponse, FrequenciesResponse, OpenStatus
from app.status import compute_open_status, is_open_now_status

logger = logging.getLogger(__name__)

# Gminy geometry is static — loaded once at startup; AED counts come from MongoDB.
_gminy: dict[str, Any] = {"type": "FeatureCollection", "features": []}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _gminy
    _gminy = load_gminy()
    await db.connect()
    yield
    await db.close()


app = FastAPI(
    title="AED Map API",
    description="Polish AED map and open-data aggregation backend",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.exception_handler(PyMongoError)
async def mongo_error_handler(_request: Request, exc: PyMongoError) -> JSONResponse:
    logger.error("MongoDB error: %s", exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "Database unavailable"},
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


def _with_status(aed: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(aed)
    status: OpenStatus = compute_open_status(aed)
    enriched["status"] = status.model_dump()
    return enriched


@app.get("/api/gminy")
async def get_gminy(
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
    counts, _unassigned = await db.count_by_gmina()
    with_counts = {
        **_gminy,
        "features": [
            {
                **feature,
                "properties": {
                    **feature["properties"],
                    "aed_count": counts.get(str(feature["properties"].get("teryt")), 0),
                },
            }
            for feature in _gminy.get("features", [])
        ],
    }
    return enrich_gminy_with_metric(with_counts, metric)  # type: ignore[arg-type]


@app.get("/api/frequencies", response_model=FrequenciesResponse)
async def get_frequencies() -> FrequenciesResponse:
    """AED counts per województwo / powiat / gmina (TERYT) for the choropleth map."""
    counts, unassigned = await db.count_by_gmina()
    rolled = rollup_counts(counts)
    return FrequenciesResponse(
        **rolled,
        total=sum(counts.values()) + unassigned,
        unassigned=unassigned,
    )


@app.get("/api/aed", response_model=AedListResponse)
async def list_aed(
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
    for doc in await db.find_aed(parsed_bbox):
        enriched = _with_status(to_api_aed(doc))
        if only_open_now:
            status = OpenStatus.model_validate(enriched["status"])
            if not is_open_now_status(status):
                continue
        items.append(enriched)

    return AedListResponse(items=items, count=len(items))  # type: ignore[arg-type]


@app.get("/api/aed/{aed_id}", response_model=AedItem)
async def get_aed(aed_id: str) -> dict[str, Any]:
    doc = await db.get_aed(aed_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"AED '{aed_id}' not found")
    return _with_status(to_api_aed(doc))


@app.get("/health")
async def health() -> dict[str, str]:
    try:
        mongo = "ok" if await db.ping() else "not_connected"
    except PyMongoError:
        mongo = "unavailable"
    return {"status": "ok", "mongo": mongo}

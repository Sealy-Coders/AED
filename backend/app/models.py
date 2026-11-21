"""Pydantic models for AED API responses."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

MetricName = Literal["aed_count", "aed_per_100km2", "aed_per_10k_pop"]

StatusKey = Literal["open_24_7", "open_now", "closed_now", "unknown"]


class OpenStatus(BaseModel):
    """Live availability status for an AED."""

    key: StatusKey
    label: str
    badge: StatusKey = Field(
        description="Status badge key for frontend styling (same as key)."
    )


class OpeningHoursSimple(BaseModel):
    """Single weekly window; days use weekday() numbering (Mon=0 … Sun=6)."""

    days: list[int]
    start: str
    end: str


class AedItem(BaseModel):
    """One AED as returned by the API (mapped from MongoDB by app.mappers)."""

    model_config = {"extra": "allow"}

    id: str
    name: str
    lat: float
    lon: float
    teryt_gmina: str | None = None
    gmina_name: str | None = None
    address: str | None = None
    city: str | None = None
    location_detail: str | None = None
    placement: str | None = None
    cabinet: str | None = None
    access_note: str | None = None
    is_24_7: bool = False
    opening_hours_simple: OpeningHoursSimple | None = None
    opening_hours_raw: str | None = None
    pediatric_mode: bool | None = None
    last_verified: str | None = None
    locked: bool = False
    operator: str | None = None
    source: str | None = None
    status: OpenStatus


class AedListResponse(BaseModel):
    """List of AED items with live status."""

    items: list[AedItem]
    count: int


class FrequenciesResponse(BaseModel):
    """
    AED counts per administrative unit, keyed by TERYT code — the shape the
    frontend map (`DefibrillatorData`) consumes.
    """

    voivodeships: dict[str, int]
    counties: dict[str, int]
    communes: dict[str, int]
    total: int = Field(description="All AED records in the database.")
    unassigned: int = Field(description="Records not located in any gmina.")


class AedDetailResponse(BaseModel):
    """Single AED record with live status."""

    model_config = {"extra": "allow"}

    id: str | int
    status: OpenStatus

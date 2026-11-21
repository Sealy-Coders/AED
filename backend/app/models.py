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


class AedListResponse(BaseModel):
    """List of AED items with live status."""

    items: list[dict[str, Any]]
    count: int


class AedDetailResponse(BaseModel):
    """Single AED record with live status."""

    model_config = {"extra": "allow"}

    id: str | int
    status: OpenStatus

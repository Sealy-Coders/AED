"""Choropleth metric computation and intensity normalization for gminy."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from app.models import MetricName

VALID_METRICS: frozenset[str] = frozenset(
    {"aed_count", "aed_per_100km2", "aed_per_10k_pop"}
)


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def compute_metric_value(properties: dict[str, Any], metric: MetricName) -> float:
    """Compute the active metric value for one gmina, safely handling zeros/missing."""
    aed_count = _as_float(properties.get("aed_count")) or 0.0

    if metric == "aed_count":
        return aed_count

    if metric == "aed_per_100km2":
        area = _as_float(properties.get("area_km2"))
        if area is None or area <= 0:
            return 0.0
        return (aed_count / area) * 100.0

    # aed_per_10k_pop
    population = _as_float(properties.get("population"))
    if population is None or population <= 0:
        return 0.0
    return (aed_count / population) * 10000.0


def enrich_gminy_with_metric(
    geojson: dict[str, Any],
    metric: MetricName,
) -> dict[str, Any]:
    """
    Return a FeatureCollection with active_metric, active_value, and intensity_score
    added to each feature's properties.
    """
    result = deepcopy(geojson)
    features = result.get("features") or []

    values: list[float] = []
    for feature in features:
        props = feature.setdefault("properties", {}) or {}
        feature["properties"] = props
        value = compute_metric_value(props, metric)
        values.append(value)
        props["active_metric"] = metric
        props["active_value"] = value

    if values:
        vmin = min(values)
        vmax = max(values)
    else:
        vmin = vmax = 0.0

    span = vmax - vmin
    for feature, value in zip(features, values):
        if span > 0:
            score = (value - vmin) / span
        else:
            score = 0.0
        feature["properties"]["intensity_score"] = max(0.0, min(1.0, score))

    return result

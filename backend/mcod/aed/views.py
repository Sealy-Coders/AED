"""
AED map API.

The endpoints return plain JSON (like the ``/cluster/*`` views) rather than
JSON:API documents: the map needs flat, compact payloads (counts per TERYT
code, thousands of points per viewport).
"""

import logging
from typing import Optional, Tuple

import falcon
from django.db import DatabaseError
from django.db.models import Count

from mcod.aed.models import AedDevice
from mcod.aed.serializers import rollup_counts, serialize_aed
from mcod.aed.status import is_open, to_warsaw

logger = logging.getLogger("mcod.aed")

TRUE_VALUES = ("1", "true", "yes", "on")


def parse_bbox(value: Optional[str]) -> Optional[Tuple[float, float, float, float]]:
    if value is None or not value.strip():
        return None
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 4:
        raise falcon.HTTPBadRequest(
            title="Invalid bbox",
            description="Expected min_lon,min_lat,max_lon,max_lat",
        )
    try:
        min_lon, min_lat, max_lon, max_lat = (float(part) for part in parts)
    except ValueError:
        raise falcon.HTTPBadRequest(title="Invalid bbox", description="All bbox values must be numbers")
    return min_lon, min_lat, max_lon, max_lat


class BaseAedView:
    def _db_unavailable(self, exc: Exception):
        logger.error("AED database error: %s", exc)
        return falcon.HTTPServiceUnavailable(title="Database unavailable", description="Database unavailable")


class AedFrequenciesView(BaseAedView):
    """``GET /aed/frequencies`` - AED counts per województwo / powiat / gmina (TERYT keys)."""

    def on_get(self, request, response, *args, **kwargs):
        try:
            rows = list(AedDevice.objects.values("teryt_gmina").annotate(count=Count("id")).values_list("teryt_gmina", "count"))
        except DatabaseError as exc:
            raise self._db_unavailable(exc)
        response.media = rollup_counts(rows)
        response.status = falcon.HTTP_200


class AedListView(BaseAedView):
    """``GET /aed?bbox=min_lon,min_lat,max_lon,max_lat&only_open_now=false`` - AED points with live status."""

    def on_get(self, request, response, *args, **kwargs):
        bbox = parse_bbox(request.get_param("bbox"))
        only_open_now = (request.get_param("only_open_now") or "").lower() in TRUE_VALUES

        queryset = AedDevice.objects.all()
        if bbox:
            min_lon, min_lat, max_lon, max_lat = bbox
            queryset = queryset.filter(
                longitude__gte=min_lon,
                longitude__lte=max_lon,
                latitude__gte=min_lat,
                latitude__lte=max_lat,
            )

        now = to_warsaw()
        try:
            items = [serialize_aed(device, now=now) for device in queryset.iterator()]
        except DatabaseError as exc:
            raise self._db_unavailable(exc)
        if only_open_now:
            items = [item for item in items if is_open(item["status"])]

        response.media = {"items": items, "count": len(items)}
        response.status = falcon.HTTP_200


class AedDetailView(BaseAedView):
    """``GET /aed/{id}`` - single AED."""

    def on_get(self, request, response, id, *args, **kwargs):
        try:
            device = AedDevice.objects.filter(id=id).first()
        except DatabaseError as exc:
            raise self._db_unavailable(exc)
        if device is None:
            raise falcon.HTTPNotFound(description=f"AED '{id}' not found")
        response.media = serialize_aed(device)
        response.status = falcon.HTTP_200

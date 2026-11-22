"""
Point-in-polygon lookup of the gmina TERYT code (``JPT_KOD_JE``).

Pure Python (no shapely/GEOS): the backend's Pipfile.lock is installed with
``pipenv install --deploy``, so the lookup avoids adding new dependencies.
A coarse grid over polygon bounding boxes keeps it fast enough for ~20k points.
"""

import json
import math
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

Ring = Sequence[Sequence[float]]
Polygon = Sequence[Ring]
BBox = Tuple[float, float, float, float]  # min_lon, min_lat, max_lon, max_lat

# Points just outside a polygon (coastline, state border) - max ~1.5 km
NEAREST_GMINA_MAX_DEG = 0.02
GRID_CELL_DEG = 0.25


def _polygons(geometry: dict) -> List[Polygon]:
    if geometry.get("type") == "Polygon":
        return [geometry["coordinates"]]
    if geometry.get("type") == "MultiPolygon":
        return list(geometry["coordinates"])
    return []


def _bbox(polygons: List[Polygon]) -> BBox:
    lons = [p[0] for polygon in polygons for p in polygon[0]]
    lats = [p[1] for polygon in polygons for p in polygon[0]]
    return min(lons), min(lats), max(lons), max(lats)


def _polygon_contains(polygon: Polygon, lon: float, lat: float) -> bool:
    """Even-odd ray casting over all rings, so holes are handled too."""
    inside = False
    for ring in polygon:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


def _segment_distance(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _distance_to_polygons(polygons: List[Polygon], lon: float, lat: float) -> float:
    best = math.inf
    for polygon in polygons:
        for ring in polygon:
            for i in range(1, len(ring)):
                best = min(best, _segment_distance(lon, lat, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]))
    return best


class GminaLocator:
    def __init__(self, features: List[dict]):
        self._items: List[Tuple[str, Optional[str], List[Polygon], BBox]] = []
        self._grid: Dict[Tuple[int, int], List[int]] = {}
        for feature in features:
            props = feature.get("properties") or {}
            code = props.get("JPT_KOD_JE") or props.get("teryt")
            polygons = _polygons(feature.get("geometry") or {})
            if not code or not polygons:
                continue
            bbox = _bbox(polygons)
            index = len(self._items)
            self._items.append((str(code), props.get("JPT_NAZWA_") or props.get("name"), polygons, bbox))
            for cell in self._cells(bbox, margin=NEAREST_GMINA_MAX_DEG):
                self._grid.setdefault(cell, []).append(index)

    @classmethod
    def from_file(cls, path: Path) -> "GminaLocator":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(data.get("features", []))

    def __len__(self):
        return len(self._items)

    @staticmethod
    def _cell(lon: float, lat: float) -> Tuple[int, int]:
        return int(math.floor(lon / GRID_CELL_DEG)), int(math.floor(lat / GRID_CELL_DEG))

    def _cells(self, bbox: BBox, margin: float = 0.0):
        x0, y0 = self._cell(bbox[0] - margin, bbox[1] - margin)
        x1, y1 = self._cell(bbox[2] + margin, bbox[3] + margin)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                yield x, y

    def locate(self, lat: float, lon: float) -> Tuple[Optional[str], Optional[str]]:
        """``(teryt, name)`` of the gmina containing the point, or the nearest one within ~1.5 km."""
        candidates = self._grid.get(self._cell(lon, lat), [])
        for index in candidates:
            code, name, polygons, bbox = self._items[index]
            if bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]:
                if any(_polygon_contains(polygon, lon, lat) for polygon in polygons):
                    return code, name

        best: Tuple[float, Optional[str], Optional[str]] = (math.inf, None, None)
        for index in candidates:
            code, name, polygons, bbox = self._items[index]
            if (
                bbox[0] - NEAREST_GMINA_MAX_DEG <= lon <= bbox[2] + NEAREST_GMINA_MAX_DEG
                and bbox[1] - NEAREST_GMINA_MAX_DEG <= lat <= bbox[3] + NEAREST_GMINA_MAX_DEG
            ):
                distance = _distance_to_polygons(polygons, lon, lat)
                if distance < best[0]:
                    best = (distance, code, name)
        if best[0] <= NEAREST_GMINA_MAX_DEG:
            return best[1], best[2]
        return None, None

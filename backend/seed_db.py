"""ETL: scraper4.py -> walidacja -> deduplikacja -> TERYT gminy -> MongoDB.

Uruchomienie (z katalogu backend/, z aktywnym venv):

    python seed_db.py                         # scrapuje na żywo i zapisuje data/aed_scraped.json
    python seed_db.py --input data/aed_scraped.json   # wczytuje wcześniej zapisany wynik
    python seed_db.py --dry-run               # bez zapisu do MongoDB

Skrypt jest idempotentny: rekordy mają deterministyczne `_id` (z zaokrąglonych
współrzędnych), zapis to `ReplaceOne(upsert=True)`, a rekordy nieobecne w
bieżącym zrzucie są usuwane (wyłączysz to flagą --keep-stale).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pymongo import ASCENDING, GEOSPHERE, MongoClient, ReplaceOne
from shapely import STRtree
from shapely.geometry import Point, shape

from app.config import BACKEND_DIR, settings
from app.scraper4 import deduplicate_poland, fetch_all_poland_aed

logger = logging.getLogger("seed_db")

DEFAULT_OUTPUT = BACKEND_DIR / "data" / "aed_scraped.json"

# Ten sam prostokąt co w scraper4.py
LAT_RANGE = (49.0, 55.0)
LON_RANGE = (14.0, 24.5)
# Punkty tuż za granicą poligonu (wybrzeże, granica państwa) — max ~1.5 km
NEAREST_GMINA_MAX_DEG = 0.02
BULK_CHUNK = 1000

TEXT_FIELDS = (
    "city",
    "address",
    "location_description",
    "opening_hours",
    "operator",
    "source",
    "source_id",
)


# --------------------------------------------------------------------------- #
# Extract
# --------------------------------------------------------------------------- #


def scrape_to_file(output: Path) -> list[dict[str, Any]]:
    logger.info("Uruchamiam scraper4.fetch_all_poland_aed() …")
    result = asyncio.run(fetch_all_poland_aed())
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        **result,
    }
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("Statystyki scrapera: %s", result.get("stats"))
    logger.info("Zapisano surowy wynik do %s", output)
    return list(result.get("records") or [])


def load_from_file(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("records"), list):
        return data["records"]
    if isinstance(data, list):
        return data
    raise ValueError(
        f"{path}: oczekiwano obiektu z kluczem 'records' (wynik scraper4) lub listy rekordów"
    )


# --------------------------------------------------------------------------- #
# Transform
# --------------------------------------------------------------------------- #


def _as_float(value: Any) -> float | None:
    try:
        return float(str(value).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def validate(records: list[Any]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Return records with normalized types plus a counter of rejection reasons."""
    valid: list[dict[str, Any]] = []
    rejected: dict[str, int] = {}

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

        rec: dict[str, Any] = {"latitude": lat, "longitude": lon}
        for field in TEXT_FIELDS:
            rec[field] = _as_text(raw.get(field))
        rec["locked"] = bool(raw.get("locked"))
        rec["source"] = rec["source"] or "unknown"
        valid.append(rec)

    return valid, rejected


def record_id(lat: float, lon: float) -> str:
    """Deterministic id (~1 m precision) — keeps re-runs idempotent."""
    digest = hashlib.sha1(f"{lat:.5f},{lon:.5f}".encode()).hexdigest()[:16]
    return f"aed-{digest}"


def deduplicate(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # 1) ta sama deduplikacja przestrzenna (15 m) co w scraperze — ważne, gdy
    #    wejściowy plik został sklejony z kilku zrzutów
    spatial = deduplicate_poland(records, radius_m=15.0)
    # 2) twarda deduplikacja po deterministycznym _id
    by_id: dict[str, dict[str, Any]] = {}
    for rec in spatial:
        rec_id = record_id(rec["latitude"], rec["longitude"])
        if rec_id not in by_id:
            by_id[rec_id] = {"_id": rec_id, **rec}
    return list(by_id.values())


class GminaLocator:
    """Point-in-polygon lookup of the gmina TERYT code (JPT_KOD_JE)."""

    def __init__(self, geojson_path: Path) -> None:
        data = json.loads(geojson_path.read_text(encoding="utf-8"))
        self._geoms = []
        self._props: list[tuple[str, str | None]] = []
        for feature in data.get("features", []):
            props = feature.get("properties") or {}
            code = props.get("JPT_KOD_JE") or props.get("teryt")
            if not code or not feature.get("geometry"):
                continue
            self._geoms.append(shape(feature["geometry"]))
            self._props.append((str(code), props.get("JPT_NAZWA_") or props.get("name")))
        self._tree = STRtree(self._geoms)
        logger.info("Wczytano %d gmin z %s", len(self._geoms), geojson_path)

    def locate(self, lat: float, lon: float) -> tuple[str | None, str | None]:
        point = Point(lon, lat)
        hits = self._tree.query(point, predicate="intersects")
        if len(hits):
            return self._props[int(hits[0])]
        nearest = self._tree.nearest(point)
        if nearest is not None and self._geoms[int(nearest)].distance(point) <= NEAREST_GMINA_MAX_DEG:
            return self._props[int(nearest)]
        return None, None


def to_documents(
    records: list[dict[str, Any]], locator: GminaLocator
) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    docs: list[dict[str, Any]] = []
    for rec in records:
        teryt, gmina_name = locator.locate(rec["latitude"], rec["longitude"])
        docs.append(
            {
                **rec,
                "location": {
                    "type": "Point",
                    "coordinates": [rec["longitude"], rec["latitude"]],
                },
                "teryt_gmina": teryt,
                "gmina_name": gmina_name,
                "updated_at": now,
            }
        )
    return docs


# --------------------------------------------------------------------------- #
# Load
# --------------------------------------------------------------------------- #


def load_into_mongo(docs: list[dict[str, Any]], *, prune: bool) -> None:
    client: MongoClient = MongoClient(settings.mongo_uri, serverSelectionTimeoutMS=5000)
    try:
        client.admin.command("ping")
        coll = client[settings.mongo_db_name][settings.mongo_collection_name]

        coll.create_index([("location", GEOSPHERE)], name="location_2dsphere")
        coll.create_index([("teryt_gmina", ASCENDING)], name="teryt_gmina")
        coll.create_index(
            [("latitude", ASCENDING), ("longitude", ASCENDING)], name="lat_lon"
        )

        upserted = modified = 0
        for start in range(0, len(docs), BULK_CHUNK):
            chunk = docs[start : start + BULK_CHUNK]
            result = coll.bulk_write(
                [ReplaceOne({"_id": d["_id"]}, d, upsert=True) for d in chunk],
                ordered=False,
            )
            upserted += result.upserted_count
            modified += result.modified_count

        deleted = 0
        if prune:
            deleted = coll.delete_many(
                {"_id": {"$nin": [d["_id"] for d in docs]}}
            ).deleted_count

        total = coll.count_documents({})
        with_teryt = coll.count_documents({"teryt_gmina": {"$ne": None}})
        logger.info(
            "MongoDB %s.%s: nowe=%d, zaktualizowane=%d, usunięte(stare)=%d, "
            "łącznie=%d, z przypisaną gminą=%d",
            settings.mongo_db_name,
            settings.mongo_collection_name,
            upserted,
            modified,
            deleted,
            total,
            with_teryt,
        )
        if total != len(docs) and prune:
            logger.warning(
                "Liczba dokumentów w kolekcji (%d) różni się od wsadu (%d)!",
                total,
                len(docs),
            )
    finally:
        client.close()


# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, help="Plik JSON z wynikiem scraper4 (pomija scrapowanie)")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Gdzie zapisać surowy wynik scrapera")
    parser.add_argument("--keep-stale", action="store_true", help="Nie usuwaj rekordów nieobecnych w bieżącym zrzucie")
    parser.add_argument("--dry-run", action="store_true", help="Tylko walidacja/transformacja, bez zapisu do MongoDB")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    raw = load_from_file(args.input) if args.input else scrape_to_file(args.output)
    logger.info("Wczytano %d surowych rekordów", len(raw))

    valid, rejected = validate(raw)
    logger.info("Poprawnych: %d, odrzuconych: %s", len(valid), rejected or 0)

    unique = deduplicate(valid)
    logger.info("Po deduplikacji: %d (scalono %d)", len(unique), len(valid) - len(unique))

    if not unique:
        logger.error("Brak rekordów do zapisu — przerywam, żeby nie wyczyścić kolekcji.")
        return 1

    docs = to_documents(unique, GminaLocator(settings.gminy_geojson_path))
    unassigned = sum(1 for d in docs if d["teryt_gmina"] is None)
    logger.info("Rekordy bez przypisanej gminy: %d", unassigned)

    if args.dry_run:
        logger.info("--dry-run: pomijam zapis. Przykład: %s", {k: v for k, v in docs[0].items() if k != "updated_at"})
        return 0

    load_into_mongo(docs, prune=not args.keep_stale)
    return 0


if __name__ == "__main__":
    sys.exit(main())

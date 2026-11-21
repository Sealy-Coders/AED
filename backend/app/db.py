"""Async MongoDB access (PyMongo native async API) for AED records."""

from __future__ import annotations

from typing import Any

from pymongo import AsyncMongoClient
from pymongo.asynchronous.collection import AsyncCollection

from app.config import settings

_client: AsyncMongoClient | None = None


async def connect() -> None:
    global _client
    if _client is None:
        _client = AsyncMongoClient(settings.mongo_uri, serverSelectionTimeoutMS=3000)


async def close() -> None:
    global _client
    if _client is not None:
        await _client.close()
        _client = None


def _collection() -> AsyncCollection:
    if _client is None:
        raise RuntimeError("MongoDB client not initialised — call db.connect() first")
    return _client[settings.mongo_db_name][settings.mongo_collection_name]


async def ping() -> bool:
    if _client is None:
        return False
    await _client.admin.command("ping")
    return True


async def find_aed(
    bbox: tuple[float, float, float, float] | None = None,
) -> list[dict[str, Any]]:
    """All AED documents, optionally limited to bbox (min_lon, min_lat, max_lon, max_lat)."""
    query: dict[str, Any] = {}
    if bbox is not None:
        min_lon, min_lat, max_lon, max_lat = bbox
        query = {
            "latitude": {"$gte": min_lat, "$lte": max_lat},
            "longitude": {"$gte": min_lon, "$lte": max_lon},
        }
    return await _collection().find(query).to_list(length=None)


async def get_aed(aed_id: str) -> dict[str, Any] | None:
    return await _collection().find_one({"_id": aed_id})


async def count_by_gmina() -> tuple[dict[str, int], int]:
    """Return ({teryt_gmina: aed_count}, number_of_records_without_gmina)."""
    cursor = await _collection().aggregate(
        [{"$group": {"_id": "$teryt_gmina", "count": {"$sum": 1}}}]
    )
    counts: dict[str, int] = {}
    unassigned = 0
    async for row in cursor:
        if row["_id"] is None:
            unassigned += int(row["count"])
        else:
            counts[str(row["_id"])] = int(row["count"])
    return counts, unassigned

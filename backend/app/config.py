"""Runtime configuration loaded from environment variables / backend/.env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent

load_dotenv(BACKEND_DIR / ".env")


def _resolve_path(raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else (BACKEND_DIR / path).resolve()


@dataclass(frozen=True)
class Settings:
    mongo_uri: str
    mongo_db_name: str
    mongo_collection_name: str
    gminy_geojson_path: Path
    cors_origins: list[str]


def get_settings() -> Settings:
    return Settings(
        mongo_uri=os.getenv("MONGO_URI", "mongodb://localhost:27017"),
        mongo_db_name=os.getenv("MONGO_DB_NAME", "aed_map"),
        mongo_collection_name=os.getenv("MONGO_COLLECTION_NAME", "aed"),
        gminy_geojson_path=_resolve_path(
            os.getenv("GMINY_GEOJSON_PATH", "../frontend/public/geojson/gminy.json")
        ),
        cors_origins=[
            origin.strip()
            for origin in os.getenv(
                "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
            ).split(",")
            if origin.strip()
        ],
    )


settings = get_settings()

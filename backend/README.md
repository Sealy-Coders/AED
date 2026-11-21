# AED Map Backend

FastAPI backend for the Polish AED (Automated External Defibrillator) map and open-data aggregation project.
AED records are scraped by `app/scraper4.py`, loaded into MongoDB by `seed_db.py` and served from there.

## Run everything in Docker

From the repository root:

```bash
docker compose up -d --build                                  # mongodb + backend (:8000) + frontend (:3000)
docker compose exec backend python seed_db.py                 # scrape + load data (first run)
docker compose exec backend python seed_db.py --input data/aed_scraped.json  # reload saved scrape
docker compose logs -f backend                                # logs
docker compose down                                           # stop (data kept in volume aed-map_mongo_data)
```

`backend/data/` is mounted into the backend container, so the scrape file is kept on the host.
`NEXT_PUBLIC_API_URL` is baked into the frontend image at build time (build arg in
`docker-compose.yml`); change it and `CORS_ORIGINS` together if the app is served
from another host, then rebuild with `docker compose up -d --build frontend`.

## Setup (local development)

```bash
# 1. MongoDB (from the repository root)
docker compose up -d mongodb

# 2. Python env (from backend/)
cd backend
python3 -m venv .venv            # on Debian/Ubuntu without python3-venv: python3 -m virtualenv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env             # adjust if needed
```

### Environment variables (`backend/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `MONGO_DB_NAME` | `aed_map` | Database name |
| `MONGO_COLLECTION_NAME` | `aed` | Collection with AED records |
| `GMINY_GEOJSON_PATH` | `../frontend/public/geojson/gminy.json` | Gminy polygons (`JPT_KOD_JE`) — TERYT lookup in the seed + geometry for `/api/gminy` |
| `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Allowed frontend origins (comma separated) |

## Seed the database

```bash
# from backend/ with venv activated
python seed_db.py                              # live scrape -> data/aed_scraped.json -> MongoDB
python seed_db.py --input data/aed_scraped.json  # re-load a saved scrape (no network)
python seed_db.py --dry-run                    # validate/transform only
python seed_db.py --keep-stale                 # don't delete records missing from this scrape
```

The seed validates records (coordinates inside Poland), de-duplicates them
(15 m spatial merge + deterministic `_id` from coordinates), assigns the gmina
TERYT code by point-in-polygon and upserts them — re-running it is idempotent.

## Run

```bash
# from backend/ with venv activated
uvicorn app.main:app --reload --port 8000
```

API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

## Endpoints

- `GET /api/frequencies` — AED counts per województwo / powiat / gmina (TERYT keys) used by the frontend map
- `GET /api/gminy?metric=aed_per_10k_pop` — choropleth metrics (`aed_count`, `aed_per_100km2`, `aed_per_10k_pop`) with `intensity_score`
- `GET /api/aed?bbox=min_lon,min_lat,max_lon,max_lat&only_open_now=false` — AED points with live open status
- `GET /api/aed/{aed_id}` — single AED detail
- `GET /health` — API + MongoDB status

If MongoDB is unreachable, data endpoints return `503 Database unavailable`.

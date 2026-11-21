# AED Map Backend

FastAPI backend for the Polish AED (Automated External Defibrillator) map and open-data aggregation project.

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# or: pip install fastapi uvicorn
```

## Run

```bash
# from backend/ with venv activated
uvicorn app.main:app --reload --port 8000
```

API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

## Data files

Place optional source files in `data/`:

| File | Description |
|------|-------------|
| `data/gminy_agg.geojson` | GeoJSON FeatureCollection of gminy with `teryt`, `name`, `aed_count`, `area_km2`, `population` |
| `data/aed_clean.json` | JSON object with an `items` list of AED records |

If a file is missing, the API falls back to small mock datasets so the server runs immediately.

## Endpoints

- `GET /api/gminy?metric=aed_per_10k_pop` — choropleth metrics (`aed_count`, `aed_per_100km2`, `aed_per_10k_pop`) with `intensity_score`
- `GET /api/aed?bbox=min_lon,min_lat,max_lon,max_lat&only_open_now=false` — AED points with live open status
- `GET /api/aed/{aed_id}` — single AED detail

"""
AED scraper (ported from the standalone AED map app, ``scraper4.py``).

Sources:
* dane.gov.pl API - datasets/resources matching "defibrylator"/"AED"
  (datastore rows, CSV/XLSX/GeoJSON files, Photon geocoding for address-only rows),
* OpenAEDMap / OpenStreetMap - all of Poland.

Results are merged with a 15 m spatial de-duplication.
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import math
import re
import time
import xml.etree.ElementTree as ET
import zipfile
from typing import Any, Dict, List, Optional

import httpx

DANE_GOV_BASE = "https://api.dane.gov.pl/1.4"
OPENAEDMAP_PL_URL = "https://openaedmap.org/api/v1/countries/PL.geojson"
PHOTON_GEOCODE_URL = "https://photon.komoot.io/api/"
HEADERS = {"Accept": "application/vnd.api+json"}

logger = logging.getLogger("mcod.aed")


def _clean_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "").strip()


def _is_aed_text(text: str) -> bool:
    t = _clean_html(text).lower()
    return "defibrylator" in t or "defibrillator" in t or bool(re.search(r"\baed\b", t))


def _puwg1992_to_wgs84(x_northing: float, y_easting: float) -> Optional[tuple[float, float]]:
    if not (130000 <= x_northing <= 800000 and 170000 <= y_easting <= 860000):
        return None
    lat = 49.0 + (x_northing - 135000.0) / 111132.0
    lon = 19.0 + (y_easting - 500000.0) / (111320.0 * math.cos(math.radians(lat)))
    if 49.0 <= lat <= 55.0 and 14.0 <= lon <= 24.5:
        return round(lat, 6), round(lon, 6)
    return None


def _extract_poland_coords(values: List[Any], named_map: Dict[str, Any]) -> Optional[tuple[float, float]]:  # noqa: C901
    lat_keys = ("lat", "latitude", "szerokosc", "szerokość", "szerokosc_geograficzna", "wgs84_y", "y_wgs84")
    lon_keys = ("lon", "lng", "longitude", "dlugosc", "długość", "dlugosc_geograficzna", "wgs84_x", "x_wgs84")

    explicit_lat, explicit_lon = None, None
    for k, v in named_map.items():
        clean_k = k.strip().lower()
        s = str(v).strip().replace(",", ".")
        try:
            num = float(s)
        except ValueError:
            continue
        if clean_k in lat_keys and 49.0 <= num <= 55.0:
            explicit_lat = num
        elif clean_k in lon_keys and 14.0 <= num <= 24.5:
            explicit_lon = num

    if explicit_lat is not None and explicit_lon is not None:
        return explicit_lat, explicit_lon

    lat, lon = None, None
    big_nums: List[float] = []
    for v in values:
        s = str(v).strip().replace(",", ".")
        try:
            num = float(s)
        except ValueError:
            continue

        if "." in s:
            if 49.0 <= num <= 55.0 and lat is None:
                lat = num
            elif 14.0 <= num <= 24.5 and lon is None:
                lon = num
        if 130000 <= num <= 860000:
            big_nums.append(num)

    if lat is not None and lon is not None:
        return lat, lon

    if len(big_nums) >= 2:
        conv = _puwg1992_to_wgs84(big_nums[0], big_nums[1]) or _puwg1992_to_wgs84(big_nums[1], big_nums[0])
        if conv:
            return conv

    return None


def _parse_xlsx_bytes(content: bytes) -> List[Dict[str, Any]]:  # noqa: C901
    rows_out: List[Dict[str, Any]] = []
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            shared_strings: List[str] = []
            if "xl/sharedStrings.xml" in z.namelist():
                ss_root = ET.fromstring(z.read("xl/sharedStrings.xml"))
                for si in ss_root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si"):
                    texts = [t.text or "" for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")]
                    shared_strings.append("".join(texts))

            sheet_files = sorted(f for f in z.namelist() if f.startswith("xl/worksheets/sheet") and f.endswith(".xml"))
            if not sheet_files:
                return []

            sheet_root = ET.fromstring(z.read(sheet_files[0]))
            raw_table: List[List[str]] = []
            for row in sheet_root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row"):
                row_vals: List[str] = []
                for c in row.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
                    c_type = c.attrib.get("t")
                    v_el = c.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v")
                    val = v_el.text if v_el is not None and v_el.text is not None else ""
                    if c_type == "s" and val.isdigit() and int(val) < len(shared_strings):
                        val = shared_strings[int(val)]
                    row_vals.append(val)
                if any(row_vals):
                    raw_table.append(row_vals)

            if len(raw_table) >= 2:
                headers = [h.strip() or f"col{i}" for i, h in enumerate(raw_table[0])]
                for r in raw_table[1:]:
                    rows_out.append({headers[i]: r[i] for i in range(min(len(headers), len(r)))})
    except Exception:
        return []
    return rows_out


async def _geocode_address(client: httpx.AsyncClient, query: str) -> Optional[tuple[float, float]]:
    """Zamienia adres tekstowy (gdy urząd nie podał GPS) na współrzędne WGS84 przez Photon (OSM)."""
    try:
        r = await client.get(
            PHOTON_GEOCODE_URL,
            params={"q": f"{query}, Polska", "limit": 1},
            timeout=4.0,
        )
        if r.status_code == 200:
            features = r.json().get("features", [])
            if features:
                lon, lat = features[0]["geometry"]["coordinates"]
                if 49.0 <= lat <= 55.0 and 14.0 <= lon <= 24.5:
                    return float(lat), float(lon)
    except Exception:
        pass
    return None


def _parse_dane_gov_row(raw_row: Dict[str, Any], ds_title: str, res_id: str) -> Optional[Dict[str, Any]]:
    flat_values: List[Any] = []
    named_map: Dict[str, Any] = {}

    for k, v in raw_row.items():
        val = v.get("val") if isinstance(v, dict) and "val" in v else v
        if val is None:
            continue
        if isinstance(val, str) and "," in val and re.match(r"^\d{2}\.\d+,\s*\d{2}\.\d+", val.strip()):
            flat_values.extend(next(csv.reader([val]), []))
        else:
            flat_values.append(val)
            named_map[str(k).lower()] = val

    coords = _extract_poland_coords(flat_values, named_map)

    text_fields = [
        str(x).strip()
        for x in flat_values
        if isinstance(x, str)
        and not re.match(r"^-?\d+([.,]\d+)?$", x.strip())
        and x.strip().lower() not in ("defibrylator", "aed", "point")
    ]
    address = (
        named_map.get("adres")
        or named_map.get("address")
        or named_map.get("ulica")
        or next((t for t in text_fields if re.search(r"\b(ul\.|al\.|pl\.|os\.|\d{2}-\d{3})\b", t, re.I)), None)
    )
    desc_candidates = [t for t in text_fields if t != address]
    location_desc = (
        named_map.get("lokalizacja")
        or named_map.get("opis")
        or named_map.get("miejsce")
        or (desc_candidates[0] if desc_candidates else "Brak szczegółowego opisu")
    )

    city_match = re.search(
        r"(?:w Mieście|na terenie Miasta|w Gminie|w Powiecie|w)\s+([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż-]+)",
        ds_title,
    )
    city = (
        named_map.get("miasto")
        or named_map.get("city")
        or named_map.get("miejscowosc")
        or named_map.get("miejscowość")
        or (city_match.group(1) if city_match else None)
    )

    # Jeśli brak GPS i brak jakiegokolwiek adresu do geokodowania — odrzucamy pusty wiersz
    if not coords and not address:
        return None

    return {
        "latitude": coords[0] if coords else None,
        "longitude": coords[1] if coords else None,
        "needs_geocoding": coords is None,
        "city": str(city).strip() if city else None,
        "address": str(address).strip() if address else None,
        "location_description": str(location_desc).strip(),
        "opening_hours": str(named_map.get("opening_hours") or named_map.get("godziny") or "nieznane").strip(),
        "locked": False,
        "operator": str(named_map.get("operator") or named_map.get("dysponent") or ds_title).strip(),
        "source": f"dane.gov.pl ({ds_title})",
        "source_id": res_id,
    }


# --- 1. GŁĘBOKI SKAN DANE.GOV.PL (ZARÓWNO /datasets JAK I /resources!) ---


async def _extract_from_resource_obj(  # noqa: C901
    client: httpx.AsyncClient, res: Dict[str, Any], parent_title: str
) -> List[Dict[str, Any]]:
    res_id = str(res["id"])
    attrs = res.get("attributes", {})
    res_title = _clean_html(attrs.get("title") or parent_title)
    fmt = (attrs.get("format") or "").lower()
    link = attrs.get("link") or attrs.get("file_url")
    records: List[Dict[str, Any]] = []

    # 1. Datastore API
    if fmt in ("csv", "xlsx", "xls", "json", "geojson"):
        try:
            data_r = await client.get(f"{DANE_GOV_BASE}/resources/{res_id}/data", params={"per_page": 1000}, timeout=7.0)
            if data_r.status_code == 200:
                for item in data_r.json().get("data", []):
                    parsed = _parse_dane_gov_row(item.get("attributes", item), res_title, res_id)
                    if parsed:
                        records.append(parsed)
        except httpx.HTTPError:
            pass

    # 2. Bezpośredni plik (GeoJSON, JSON, CSV, XLSX)
    if not records and link and fmt in ("geojson", "json", "csv", "xlsx"):
        try:
            file_r = await client.get(link, timeout=7.0)
            if file_r.status_code == 200 and "text/html" not in file_r.headers.get("content-type", ""):
                if fmt in ("geojson", "json"):
                    data = file_r.json()
                    features = data.get("features", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
                    for feat in features:
                        props = feat.get("properties", feat) if isinstance(feat, dict) else {}
                        coords = (feat.get("geometry") or {}).get("coordinates", []) if isinstance(feat, dict) else []
                        if len(coords) >= 2:
                            props = {**props, "lon": coords[0], "lat": coords[1]}
                        parsed = _parse_dane_gov_row(props, res_title, res_id)
                        if parsed:
                            records.append(parsed)
                elif fmt == "csv":
                    text = file_r.content.decode("utf-8-sig", errors="replace")
                    delim = ";" if text.count(";") > text.count(",") else ","
                    for row in csv.DictReader(io.StringIO(text), delimiter=delim):
                        parsed = _parse_dane_gov_row(row, res_title, res_id)
                        if parsed:
                            records.append(parsed)
                elif fmt == "xlsx":
                    for row in _parse_xlsx_bytes(file_r.content):
                        parsed = _parse_dane_gov_row(row, res_title, res_id)
                        if parsed:
                            records.append(parsed)
        except Exception:
            pass

    return records


async def fetch_poland_dane_gov(client: httpx.AsyncClient) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:  # noqa: C901
    t0 = time.perf_counter()

    # Odpytujemy JEDNOCZEŚNIE /datasets ORAZ /resources (łapie pliki ukryte w ogólnych zbiorach gmin!)
    queries = ["defibrylator", "defibrylatory", "AED"]
    ds_tasks = [client.get(f"{DANE_GOV_BASE}/datasets", params={"q": q, "per_page": 50}, timeout=8.0) for q in queries]
    res_tasks = [client.get(f"{DANE_GOV_BASE}/resources", params={"q": q, "per_page": 50}, timeout=8.0) for q in queries]

    all_responses = await asyncio.gather(*(ds_tasks + res_tasks), return_exceptions=True)

    discovered_datasets: Dict[str, str] = {}
    standalone_resources: Dict[str, Dict[str, Any]] = {}

    for resp in all_responses:
        if not isinstance(resp, httpx.Response) or resp.status_code != 200:
            continue
        for item in resp.json().get("data", []):
            item_type = item.get("type")
            item_id = str(item.get("id"))
            title = _clean_html(item.get("attributes", {}).get("title", ""))

            if item_type == "dataset" and _is_aed_text(title):
                discovered_datasets[item_id] = title
            elif item_type == "resource" and _is_aed_text(title):
                standalone_resources[item_id] = item

    # Pobieramy zasoby ze znalezionych datasets i dokładamy je do puli unikalnych resources
    if discovered_datasets:
        ds_res_responses = await asyncio.gather(
            *[client.get(f"{DANE_GOV_BASE}/datasets/{ds_id}/resources", timeout=7.0) for ds_id in discovered_datasets],
            return_exceptions=True,
        )
        for r in ds_res_responses:
            if isinstance(r, httpx.Response) and r.status_code == 200:
                for res in r.json().get("data", []):
                    standalone_resources[str(res["id"])] = res

    # Parsujemy wszystkie unikalne zasoby równolegle
    extracted_lists = await asyncio.gather(
        *[
            _extract_from_resource_obj(client, res, _clean_html(res.get("attributes", {}).get("title", "")))
            for res in standalone_resources.values()
        ]
    )

    raw_records: List[Dict[str, Any]] = []
    audit_report: List[Dict[str, Any]] = []

    for res_obj, recs in zip(standalone_resources.values(), extracted_lists):
        res_id = str(res_obj["id"])
        attrs = res_obj.get("attributes", {})
        fmt = (attrs.get("format") or "?").lower()
        title = _clean_html(attrs.get("title", "Bez nazwy"))

        audit_report.append(
            {
                "resource_id": res_id,
                "title": title,
                "format": fmt,
                "extracted_count": len(recs),
                "status": "OK" if recs else f"NIEODCZYTYWALNY_FORMAT ({fmt})_LUB_BRAK_DANYCH",
            }
        )
        raw_records.extend(recs)

    # Automatyczne geokodowanie rekordów z dane.gov.pl, które miały tylko adres tekstowy bez GPS
    final_records: List[Dict[str, Any]] = []
    for rec in raw_records:
        if rec.pop("needs_geocoding", False):
            query = f"{rec['address']}, {rec['city'] or ''}".strip(", ")
            geo = await _geocode_address(client, query)
            if geo:
                rec["latitude"], rec["longitude"] = geo
                rec["source"] += " [geokodowane z adresu]"
                final_records.append(rec)
        else:
            final_records.append(rec)

    logger.info(
        f"dane.gov.pl (skan datasets + resources) zakończone w {time.perf_counter() - t0:.2f}s "
        f"({len(final_records)} pkt z {len(standalone_resources)} zasobów)"
    )
    return final_records, audit_report


# --- 2. ŹRÓDŁO: OPENAEDMAP / OPENSTREETMAP (CAŁA POLSKA) ---


async def fetch_poland_openaedmap(client: httpx.AsyncClient) -> List[Dict[str, Any]]:
    t0 = time.perf_counter()
    try:
        resp = await client.get(
            OPENAEDMAP_PL_URL,
            headers={"Accept": "application/json", "User-Agent": "MisjaAED-Hackathon/1.0"},
            timeout=15.0,
        )
        resp.raise_for_status()
        features = resp.json().get("features", [])
    except Exception as e:
        logger.warning(f"Błąd OpenAEDMap: {type(e).__name__}: {e}")
        return []

    records: List[Dict[str, Any]] = []
    for feat in features:
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            continue

        lon, lat = float(coords[0]), float(coords[1])
        props = feat.get("properties") or {}

        street = f"{props.get('addr:street', '')} {props.get('addr:housenumber', '')}".strip() or None
        desc = (
            props.get("defibrillator:location:pl")
            or props.get("defibrillator:location")
            or props.get("description")
            or "Brak szczegółowego opisu"
        )

        records.append(
            {
                "latitude": lat,
                "longitude": lon,
                "city": props.get("addr:city"),
                "address": street,
                "location_description": desc,
                "opening_hours": props.get("opening_hours") or "nieznane",
                "locked": props.get("locked") == "yes",
                "operator": props.get("operator"),
                "source": "OpenAEDMap / OpenStreetMap",
                "source_id": str(feat.get("id") or props.get("osm_id") or ""),
            }
        )

    logger.info(f"OpenAEDMap (cała Polska) zakończone w {time.perf_counter() - t0:.2f}s ({len(records)} pkt)")
    return records


# --- 3. DEDUPLIKACJA PRZESTRZENNA ---


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def deduplicate_poland(records: List[Dict[str, Any]], radius_m: float = 15.0) -> List[Dict[str, Any]]:  # noqa: C901
    grid: Dict[tuple[int, int], List[Dict[str, Any]]] = {}
    merged: List[Dict[str, Any]] = []

    for rec in records:
        cell_x = int(rec["latitude"] * 1000)
        cell_y = int(rec["longitude"] * 1000)

        duplicate = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for candidate in grid.get((cell_x + dx, cell_y + dy), []):
                    if _haversine_m(rec["latitude"], rec["longitude"], candidate["latitude"], candidate["longitude"]) <= radius_m:
                        duplicate = candidate
                        break
                if duplicate:
                    break
            if duplicate:
                break

        if not duplicate:
            merged.append(rec)
            grid.setdefault((cell_x, cell_y), []).append(rec)
        else:
            if not duplicate.get("city") and rec.get("city"):
                duplicate["city"] = rec["city"]
            if not duplicate.get("address") and rec.get("address"):
                duplicate["address"] = rec["address"]
            if duplicate.get("opening_hours") == "nieznane" and rec.get("opening_hours") != "nieznane":
                duplicate["opening_hours"] = rec["opening_hours"]
            if rec.get("locked"):
                duplicate["locked"] = True
            if rec["source"] not in duplicate["source"]:
                duplicate["source"] = f"{duplicate['source']} + {rec['source']}"

    return merged


# --- GŁÓWNY AGREGATOR OGÓLNOPOLSKI ---


async def fetch_all_poland_aed() -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=15.0, headers=HEADERS, follow_redirects=True) as client:
        (danegov_records, audit_report), osm_records = await asyncio.gather(
            fetch_poland_dane_gov(client),
            fetch_poland_openaedmap(client),
        )

    combined = danegov_records + osm_records
    deduped = deduplicate_poland(combined, radius_m=15.0)

    return {
        "stats": {
            "dane_gov_pl_count": len(danegov_records),
            "openstreetmap_pl_count": len(osm_records),
            "merged_unique_poland_total": len(deduped),
            "duplicates_merged": len(combined) - len(deduped),
        },
        "dane_gov_audit": audit_report,
        "records": deduped,
    }

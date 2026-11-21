/**
 * Shared, lazily-loaded gminy polygons (`/geojson/gminy.json`, ~12 MB).
 * The file is fetched and parsed once and reused by the city search and the
 * "my location" lookup.
 */

type Ring = number[][];

export type GminaFeature = {
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: Ring[] | Ring[][];
  };
  properties?: {
    JPT_KOD_JE?: string;
    JPT_NAZWA_?: string;
  };
};

/** [minLon, minLat, maxLon, maxLat] */
export type BBox = [number, number, number, number];

export type GminaMatch = {
  code: string;
  name: string;
  bbox: BBox;
};

let gminyPromise: Promise<GminaFeature[]> | null = null;

export function loadGminyFeatures(): Promise<GminaFeature[]> {
  if (!gminyPromise) {
    gminyPromise = fetch("/geojson/gminy.json")
      .then((response) => {
        if (!response.ok) throw new Error("Nie udało się wczytać granic gmin");
        return response.json() as Promise<{ features: GminaFeature[] }>;
      })
      .then((geojson) => geojson.features ?? [])
      .catch((error: unknown) => {
        gminyPromise = null; // allow a retry on the next call
        throw error;
      });
  }
  return gminyPromise;
}

function polygonsOf(feature: GminaFeature): Ring[][] {
  return feature.geometry.type === "Polygon"
    ? [feature.geometry.coordinates as Ring[]]
    : (feature.geometry.coordinates as Ring[][]);
}

const bboxCache = new WeakMap<GminaFeature, BBox>();

export function featureBBox(feature: GminaFeature): BBox {
  const cached = bboxCache.get(feature);
  if (cached) return cached;

  const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of polygonsOf(feature)) {
    for (const [lon, lat] of polygon[0] ?? []) {
      if (lon < bbox[0]) bbox[0] = lon;
      if (lat < bbox[1]) bbox[1] = lat;
      if (lon > bbox[2]) bbox[2] = lon;
      if (lat > bbox[3]) bbox[3] = lat;
    }
  }
  bboxCache.set(feature, bbox);
  return bbox;
}

/** Even-odd ray casting over all rings, so holes are handled too. */
function polygonContains(polygon: Ring[], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Gmina containing the point, or `null` (e.g. outside Poland). */
export function findGminaAt(
  features: GminaFeature[],
  lon: number,
  lat: number,
): GminaMatch | null {
  for (const feature of features) {
    const bbox = featureBBox(feature);
    if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) {
      continue;
    }
    if (polygonsOf(feature).some((polygon) => polygonContains(polygon, lon, lat))) {
      return {
        code: String(feature.properties?.JPT_KOD_JE ?? ""),
        name: String(feature.properties?.JPT_NAZWA_ ?? "Gmina").trim(),
        bbox,
      };
    }
  }
  return null;
}

import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

type Ring = number[][];

export interface GminaFeature {
  type?: 'Feature';
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: Ring[] | Ring[][];
  };
  properties?: {
    JPT_KOD_JE?: string;
    JPT_NAZWA_?: string;
  };
}

export interface GminyCollection {
  type: 'FeatureCollection';
  features: GminaFeature[];
}

/** [minLon, minLat, maxLon, maxLat] */
export type BBox = [number, number, number, number];

export interface GminaMatch {
  code: string;
  name: string;
  bbox: BBox;
}

/** Gminy polygons bundled with the app (~12 MB, `JPT_KOD_JE` = 7-digit TERYT). */
export const GMINY_GEOJSON_URL = 'assets/geojson/gminy.json';

/**
 * Lazily loaded, shared gminy polygons: fetched and parsed once, reused by the map
 * layer, the city search and the "my location" lookup.
 */
@Injectable({
  providedIn: 'root',
})
export class GminyService {
  private readonly http = inject(HttpClient);
  private gminyPromise: Promise<GminyCollection> | null = null;
  private readonly bboxCache = new WeakMap<GminaFeature, BBox>();

  load(): Promise<GminyCollection> {
    if (!this.gminyPromise) {
      this.gminyPromise = firstValueFrom(this.http.get<GminyCollection>(GMINY_GEOJSON_URL)).catch((error: unknown) => {
        this.gminyPromise = null; // allow a retry on the next call
        throw error;
      });
    }
    return this.gminyPromise;
  }

  featureBBox(feature: GminaFeature): BBox {
    const cached = this.bboxCache.get(feature);
    if (cached) {
      return cached;
    }

    const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of polygonsOf(feature)) {
      for (const [lon, lat] of polygon[0] ?? []) {
        bbox[0] = Math.min(bbox[0], lon);
        bbox[1] = Math.min(bbox[1], lat);
        bbox[2] = Math.max(bbox[2], lon);
        bbox[3] = Math.max(bbox[3], lat);
      }
    }
    this.bboxCache.set(feature, bbox);
    return bbox;
  }

  /** Gmina containing the point, or `null` (e.g. outside Poland). */
  findGminaAt(features: GminaFeature[], lon: number, lat: number): GminaMatch | null {
    for (const feature of features) {
      const bbox = this.featureBBox(feature);
      if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) {
        continue;
      }
      if (polygonsOf(feature).some((polygon) => polygonContains(polygon, lon, lat))) {
        return {
          code: String(feature.properties?.JPT_KOD_JE ?? ''),
          name: String(feature.properties?.JPT_NAZWA_ ?? 'Gmina').trim(),
          bbox,
        };
      }
    }
    return null;
  }
}

export function polygonsOf(feature: GminaFeature): Ring[][] {
  return feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates as Ring[]]
    : (feature.geometry.coordinates as Ring[][]);
}

/** Even-odd ray casting over all rings, so holes are handled too. */
export function polygonContains(polygon: Ring[], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function ringCentroid(ring: Ring): [number, number] | null {
  let longitude = 0;
  let latitude = 0;
  let points = 0;
  for (const point of ring ?? []) {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      continue;
    }
    longitude += point[0];
    latitude += point[1];
    points += 1;
  }
  return points ? [longitude / points, latitude / points] : null;
}

/** Centroid of the outer ring of the largest polygon (vertex average, good enough for labels/pins). */
export function geometryCentroid(feature: GminaFeature): [number, number] | null {
  if (!feature?.geometry?.coordinates) {
    return null;
  }
  let largest: Ring = [];
  let largestArea = -1;
  for (const polygon of polygonsOf(feature)) {
    const ring = polygon[0] ?? [];
    let area = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const current = ring[i];
      const next = ring[(i + 1) % ring.length];
      area += current[0] * next[1] - next[0] * current[1];
    }
    if (Math.abs(area) > largestArea) {
      largestArea = Math.abs(area);
      largest = ring;
    }
  }
  return ringCentroid(largest);
}

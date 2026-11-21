"use client";

import { useEffect, useMemo, useState } from "react";

export type CitySearchTarget = {
  name: string;
  voivodeship: string;
  code: string;
  longitude: number;
  latitude: number;
};

type CitySearchProps = {
  onSelect: (target: CitySearchTarget) => void;
};

type GeoJsonFeature = {
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
  properties?: {
    JPT_KOD_JE?: string;
    JPT_NAZWA_?: string;
  };
};

const VOIVODESHIPS: Record<string, string> = {
  "02": "dolnośląskie",
  "04": "kujawsko-pomorskie",
  "06": "lubelskie",
  "08": "lubuskie",
  "10": "łódzkie",
  "12": "małopolskie",
  "14": "mazowieckie",
  "16": "opolskie",
  "18": "podkarpackie",
  "20": "podlaskie",
  "22": "pomorskie",
  "24": "śląskie",
  "26": "świętokrzyskie",
  "28": "warmińsko-mazurskie",
  "30": "wielkopolskie",
  "32": "zachodniopomorskie",
};

function normalize(value: string) {
  return value
    .toLocaleLowerCase("pl-PL")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function ringCentroid(ring: number[][]) {
  let longitude = 0;
  let latitude = 0;
  for (const point of ring) {
    longitude += point[0];
    latitude += point[1];
  }
  const length = ring.length || 1;
  return [longitude / length, latitude / length] as const;
}

function geometryCentroid(feature: GeoJsonFeature) {
  if (feature.geometry.type === "Polygon") {
    return ringCentroid(feature.geometry.coordinates[0] as number[][]);
  }

  const polygons = feature.geometry.coordinates as number[][][][];
  let largest: number[][] = [];
  let largestArea = -1;

  for (const polygon of polygons) {
    const ring = polygon[0];
    let area = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const current = ring[i];
      const next = ring[(i + 1) % ring.length];
      area += current[0] * next[1] - next[0] * current[1];
    }
    const absoluteArea = Math.abs(area);
    if (absoluteArea > largestArea) {
      largestArea = absoluteArea;
      largest = ring;
    }
  }

  return ringCentroid(largest);
}

export default function CitySearch({ onSelect }: CitySearchProps) {
  const [query, setQuery] = useState("");
  const [cities, setCities] = useState<CitySearchTarget[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/geojson/gminy.json")
      .then((response) => {
        if (!response.ok) throw new Error("Nie udało się wczytać miejscowości");
        return response.json();
      })
      .then((geojson: { features: GeoJsonFeature[] }) => {
        const targets = geojson.features
          .map((feature) => {
            const code = String(feature.properties?.JPT_KOD_JE ?? "");
            const name = String(feature.properties?.JPT_NAZWA_ ?? "").trim();
            if (!code || !name) return null;
            const [longitude, latitude] = geometryCentroid(feature);
            return {
              name,
              voivodeship: VOIVODESHIPS[code.slice(0, 2)] ?? "Nieznane województwo",
              code,
              longitude,
              latitude,
            };
          })
          .filter((item): item is CitySearchTarget => item !== null);
        setCities(targets);
      })
      .catch((error: unknown) => console.error(error))
      .finally(() => setLoading(false));
  }, []);

  const suggestions = useMemo(() => {
    const normalizedQuery = normalize(query.trim());
    if (!normalizedQuery) return [];

    return cities
      .map((city) => {
        const normalizedName = normalize(city.name);
        const score = normalizedName === normalizedQuery
          ? 0
          : normalizedName.startsWith(normalizedQuery)
            ? 1
            : normalizedName.includes(normalizedQuery)
              ? 2
              : 3;
        return { city, score };
      })
      .filter(({ score }) => score < 3)
      .sort((left, right) =>
        left.score - right.score ||
        left.city.name.localeCompare(right.city.name, "pl") ||
        left.city.voivodeship.localeCompare(right.city.voivodeship, "pl"),
      )
      .slice(0, 8)
      .map(({ city }) => city);
  }, [cities, query]);

  return (
    <aside className="flex h-full min-h-[520px] flex-col rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <label htmlFor="city-search" className="text-sm font-semibold text-slate-900">
        Wyszukaj miejscowość
      </label>
      <div className="relative mt-2">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </svg>
        <input
          id="city-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Np. Gdańsk"
          autoComplete="off"
          className="w-full rounded-xl border border-slate-300 bg-white py-3 pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-100"
        />
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="py-3 text-sm text-slate-500">Ładowanie miejscowości...</p>
        ) : query.trim() && suggestions.length === 0 ? (
          <p className="py-3 text-sm text-slate-500">Brak wyników.</p>
        ) : (
          <ul className="space-y-2">
            {suggestions.map((city) => (
              <li key={`${city.code}-${city.name}`}>
                <button
                  type="button"
                  onClick={() => onSelect(city)}
                  className="w-full rounded-xl border border-transparent px-3 py-3 text-left transition hover:border-sky-200 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  <span className="block text-sm font-semibold text-slate-900">
                    {city.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    woj. {city.voivodeship}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

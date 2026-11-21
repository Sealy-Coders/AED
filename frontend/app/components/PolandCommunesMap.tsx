"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  setWorkerUrl,
  type FillLayerSpecification,
} from "maplibre-gl";
import Map, {
  Layer,
  NavigationControl,
  Popup,
  Source,
  type MapRef,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

export type DefibrillatorData = {
  voivodeships?: Record<string, number>;
  counties?: Record<string, number>;
  communes?: Record<string, number>;
};

type HoveredArea = {
  longitude: number;
  latitude: number;
  name: string;
  count: number;
  level: "województwo" | "powiat" | "gmina";
};

type PolandCommunesMapProps = {
  defibrillatorData?: DefibrillatorData;
};

const RED_COLORS = [
  "#fee2e2",
  "#fecaca",
  "#fca5a5",
  "#f87171",
  "#ef4444",
  "#b91c1c",
] as const;

const GEOJSON_BASE =
  "https://raw.githubusercontent.com/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy/main";

if (typeof window !== "undefined") {
  setWorkerUrl("/maplibre-worker");
}

export default function PolandCommunesMap({
  defibrillatorData,
}: PolandCommunesMapProps) {
  const mapRef = useRef<MapRef>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [zoom, setZoom] = useState(5.7);
  const [demoData, setDemoData] = useState<DefibrillatorData>({});
  const [hoveredArea, setHoveredArea] = useState<HoveredArea | null>(null);

  useEffect(() => {
    if (defibrillatorData) return;

    fetch("/demo-frequencies.json")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Nie udało się wczytać danych demonstracyjnych");
        }
        return response.json();
      })
      .then((data: DefibrillatorData) => setDemoData(data))
      .catch((error: unknown) => console.error(error));
  }, [defibrillatorData]);

  const data = defibrillatorData ?? demoData;
  const level: HoveredArea["level"] =
    zoom >= 9 ? "gmina" : zoom >= 7 ? "powiat" : "województwo";

  const maxCount = useMemo(() => {
    const activeData =
      level === "gmina"
        ? data.communes
        : level === "powiat"
          ? data.counties
          : data.voivodeships;

    return Math.max(0, ...Object.values(activeData ?? {}));
  }, [data, level]);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;

    const map = mapRef.current;
    const sources = [
      {
        id: "wojewodztwa",
        activeData: data.voivodeships,
      },
      {
        id: "powiaty",
        activeData: data.counties,
      },
      {
        id: "gminy",
        activeData: data.communes,
      },
    ] as const;

    for (const source of sources) {
      const features = map.querySourceFeatures(source.id);
      for (const feature of features) {
        const code = String(feature.properties?.JPT_KOD_JE ?? "");
        const count = source.activeData?.[code] ?? 0;
        const normalizedCount =
          level === "gmina" && source.id === "gminy"
            ? maxCount > 0
              ? count / maxCount
              : 0
            : level === "powiat" && source.id === "powiaty"
              ? maxCount > 0
                ? count / maxCount
                : 0
              : level === "województwo" && source.id === "wojewodztwa"
                ? maxCount > 0
                  ? count / maxCount
                  : 0
                : 0;

        map.setFeatureState(
          { source: source.id, id: feature.id },
          { frequency: normalizedCount },
        );
      }
    }
  }, [data, level, mapLoaded, maxCount]);

  const fillPaint: FillLayerSpecification["paint"] = {
    "fill-color": [
      "interpolate",
      ["linear"],
      ["coalesce", ["feature-state", "frequency"], 0],
      0,
      RED_COLORS[0],
      0.2,
      RED_COLORS[1],
      0.4,
      RED_COLORS[2],
      0.6,
      RED_COLORS[3],
      0.8,
      RED_COLORS[4],
      1,
      RED_COLORS[5],
    ],
    "fill-opacity": 0.82,
  };

  const visibleLevel =
    zoom >= 9
      ? "gminy"
      : zoom >= 7
        ? "powiaty"
        : "wojewodztwa";
  const interactiveLayerIds = [`${visibleLevel}-fill`];

  return (
    <div className="relative h-full min-h-[520px] w-full overflow-hidden rounded-3xl border border-slate-200 bg-slate-100 shadow-sm">
      <Map
        ref={mapRef}
        initialViewState={{
          longitude: 19.2,
          latitude: 52.1,
          zoom: 5.7,
        }}
        minZoom={5}
        maxZoom={12}
        mapStyle="https://tiles.openfreemap.org/styles/positron"
        dragRotate={false}
        touchPitch={false}
        interactiveLayerIds={interactiveLayerIds}
        onLoad={() => setMapLoaded(true)}
        onMove={(event) => setZoom(event.viewState.zoom)}
        onMouseMove={(event) => {
          const feature = event.features?.[0];
          if (!feature) {
            setHoveredArea(null);
            return;
          }

          const properties = feature.properties;
          const code = String(properties?.JPT_KOD_JE ?? "");
          let count = 0;
          let name = "Obszar";

          if (level === "gmina") {
            count = data.communes?.[code] ?? 0;
            name = String(properties?.JPT_NAZWA_ ?? "Gmina");
          } else if (level === "powiat") {
            count = data.counties?.[code] ?? 0;
            name = String(properties?.JPT_NAZWA_ ?? "Powiat");
          } else {
            count = data.voivodeships?.[code] ?? 0;
            name = String(properties?.JPT_NAZWA_ ?? "Województwo");
          }

          setHoveredArea({
            longitude: event.lngLat.lng,
            latitude: event.lngLat.lat,
            name,
            count,
            level,
          });
        }}
        onMouseLeave={() => setHoveredArea(null)}
      >
        <Source
          id="wojewodztwa"
          type="geojson"
          data={`${GEOJSON_BASE}/wojewodztwa.json`}
          promoteId="JPT_KOD_JE"
        >
          <Layer
            id="wojewodztwa-fill"
            type="fill"
            minzoom={5}
            maxzoom={7}
            paint={fillPaint}
          />
          <Layer
            id="wojewodztwa-border"
            type="line"
            minzoom={5}
            maxzoom={7}
            paint={{
              "line-color": "#ffffff",
              "line-width": 1.2,
              "line-opacity": 0.9,
            }}
          />
        </Source>

        <Source
          id="powiaty"
          type="geojson"
          data={`${GEOJSON_BASE}/powiaty.json`}
          promoteId="JPT_KOD_JE"
        >
          <Layer
            id="powiaty-fill"
            type="fill"
            minzoom={7}
            maxzoom={9}
            paint={fillPaint}
          />
          <Layer
            id="powiaty-border"
            type="line"
            minzoom={7}
            maxzoom={9}
            paint={{
              "line-color": "#ffffff",
              "line-width": 0.7,
              "line-opacity": 0.85,
            }}
          />
        </Source>

        <Source
          id="gminy"
          type="geojson"
          data="/geojson/gminy.json"
          promoteId="JPT_KOD_JE"
        >
          <Layer
            id="gminy-fill"
            type="fill"
            minzoom={9}
            paint={fillPaint}
          />
          <Layer
            id="gminy-border"
            type="line"
            minzoom={9}
            paint={{
              "line-color": "#ffffff",
              "line-width": 0.35,
              "line-opacity": 0.75,
            }}
          />
        </Source>

        <NavigationControl position="top-right" showCompass={false} />

        {hoveredArea && (
          <Popup
            longitude={hoveredArea.longitude}
            latitude={hoveredArea.latitude}
            closeButton={false}
            closeOnClick={false}
            offset={10}
            className="commune-popup"
          >
            <div className="px-1 py-0.5">
              <strong className="block text-sm text-slate-900">
                {hoveredArea.name}
              </strong>
              <span className="text-xs text-slate-600">
                Defibrylatory: {hoveredArea.count}
              </span>
            </div>
          </Popup>
        )}
      </Map>

      <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 shadow-md">
        <p className="mb-1 text-xs font-semibold text-slate-700">
          Defibrylatory - {level}
        </p>
        <div className="flex items-center gap-1">
          {RED_COLORS.map((color) => (
            <span
              key={color}
              className="h-2 w-5"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

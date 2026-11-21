"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
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

/** Response of `GET /api/frequencies` (counts keyed by TERYT code). */
export type FrequenciesResponse = Required<DefibrillatorData> & {
  total: number;
  unassigned: number;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DefibrillatorData; total: number };

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

export type PolandCommunesMapHandle = {
  flyToLocation: (longitude: number, latitude: number) => void;
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

const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

const EMPTY_DATA: DefibrillatorData = {};

function countTotal(data: DefibrillatorData): number {
  return Object.values(data.voivodeships ?? {}).reduce((a, b) => a + b, 0);
}

if (typeof window !== "undefined") {
  setWorkerUrl("/maplibre-worker");
}

const PolandCommunesMap = forwardRef<
  PolandCommunesMapHandle,
  PolandCommunesMapProps
>(function PolandCommunesMap({ defibrillatorData }, ref) {
  const mapRef = useRef<MapRef>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [zoom, setZoom] = useState(5.7);
  const [hoveredArea, setHoveredArea] = useState<HoveredArea | null>(null);
  const [fetchState, setFetchState] = useState<LoadState>({
    status: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      flyToLocation: (longitude, latitude) => {
        mapRef.current?.getMap().flyTo({
          center: [longitude, latitude],
          zoom: 10,
          duration: 1200,
        });
      },
    }),
    [],
  );

  useEffect(() => {
    if (defibrillatorData) return;

    const controller = new AbortController();

    fetch(`${API_URL}/api/frequencies`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            response.status === 503
              ? "Baza danych jest niedostępna"
              : `Błąd serwera (${response.status})`,
          );
        }
        return response.json() as Promise<FrequenciesResponse>;
      })
      .then((response) => {
        setFetchState({
          status: "ready",
          data: {
            voivodeships: response.voivodeships ?? {},
            counties: response.counties ?? {},
            communes: response.communes ?? {},
          },
          total: response.total ?? 0,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error(error);
        setFetchState({
          status: "error",
          message:
            error instanceof TypeError
              ? "Brak połączenia z serwerem API"
              : error instanceof Error
                ? error.message
                : "Nieznany błąd",
        });
      });

    return () => controller.abort();
  }, [defibrillatorData, reloadKey]);

  const loadState: LoadState = defibrillatorData
    ? {
        status: "ready",
        data: defibrillatorData,
        total: countTotal(defibrillatorData),
      }
    : fetchState;
  const data =
    loadState.status === "ready" ? loadState.data : EMPTY_DATA;
  const level: HoveredArea["level"] =
    zoom >= 9 ? "gmina" : zoom >= 7 ? "powiat" : "województwo";

  const sources = useMemo(
    () =>
      [
        { id: "wojewodztwa", activeData: data.voivodeships },
        { id: "powiaty", activeData: data.counties },
        { id: "gminy", activeData: data.communes },
      ] as const,
    [data],
  );

  // Feature ids come from `promoteId="JPT_KOD_JE"`, so state can be set per
  // TERYT code directly — this also colours tiles loaded later (pan/zoom).
  // Each source is normalised by its own max; only one level is visible at a time.
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;

    const map = mapRef.current.getMap();
    for (const source of sources) {
      if (!map.getSource(source.id)) continue;
      map.removeFeatureState({ source: source.id });
      const entries = Object.entries(source.activeData ?? {});
      const maxCount = Math.max(0, ...entries.map(([, count]) => count));
      if (maxCount === 0) continue;
      for (const [code, count] of entries) {
        map.setFeatureState(
          { source: source.id, id: code },
          { frequency: count / maxCount },
        );
      }
    }
  }, [sources, mapLoaded]);

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

      {loadState.status === "loading" && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-4 mx-auto w-fit rounded-xl border border-slate-200 bg-white/95 px-4 py-2 text-sm text-slate-700 shadow-md"
        >
          Wczytywanie danych o defibrylatorach…
        </div>
      )}

      {loadState.status === "error" && (
        <div
          role="alert"
          className="absolute inset-x-0 top-4 mx-auto flex w-fit items-center gap-3 rounded-xl border border-red-200 bg-white/95 px-4 py-2 text-sm text-red-800 shadow-md"
        >
          <span>Nie udało się wczytać danych: {loadState.message}</span>
          <button
            type="button"
            onClick={() => {
              setFetchState({ status: "loading" });
              setReloadKey((key) => key + 1);
            }}
            className="rounded-lg bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700"
          >
            Spróbuj ponownie
          </button>
        </div>
      )}

      {loadState.status === "ready" && loadState.total === 0 && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-4 mx-auto w-fit rounded-xl border border-amber-200 bg-white/95 px-4 py-2 text-sm text-amber-800 shadow-md"
        >
          Brak danych o defibrylatorach w bazie.
        </div>
      )}

      <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 shadow-md">
        <p className="mb-1 text-xs font-semibold text-slate-700">
          Defibrylatory - {level}
          {loadState.status === "ready" && loadState.total > 0 && (
            <span className="ml-1 font-normal text-slate-500">
              (łącznie {loadState.total.toLocaleString("pl-PL")})
            </span>
          )}
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
});

export default PolandCommunesMap;

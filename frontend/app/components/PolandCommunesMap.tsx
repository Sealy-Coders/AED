"use client";

import {
  forwardRef,
  useCallback,
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
  Marker,
  NavigationControl,
  Popup,
  Source,
  type MapRef,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { findGminaAt, loadGminyFeatures, type GminaMatch } from "../lib/gminy";

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

export type AedStatus = {
  key: "open_24_7" | "open_now" | "closed_now" | "unknown";
  label: string;
  badge: "open_24_7" | "open_now" | "closed_now" | "unknown";
};

export type AedItem = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  teryt_gmina?: string | null;
  gmina_name?: string | null;
  address?: string | null;
  city?: string | null;
  location_detail?: string | null;
  placement?: string | null;
  cabinet?: string | null;
  access_note?: string | null;
  is_24_7: boolean;
  opening_hours_simple?: {
    days: number[];
    start: string;
    end: string;
  } | null;
  opening_hours_raw?: string | null;
  pediatric_mode?: boolean | null;
  last_verified?: string | null;
  locked: boolean;
  operator?: string | null;
  source?: string | null;
  status: AedStatus;
};

type AedListResponse = {
  items: AedItem[];
  count: number;
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

type SelectedLocation = {
  longitude: number;
  latitude: number;
  name: string;
  voivodeship: string;
};

type UserLocation = {
  longitude: number;
  latitude: number;
  /** Radius in metres (GeolocationCoordinates.accuracy). */
  accuracy: number;
};

type GeoState =
  | { status: "locating" }
  | { status: "active" }
  | { status: "off" }
  | { status: "error"; message: string };

export type PolandCommunesMapHandle = {
  flyToLocation: (
    longitude: number,
    latitude: number,
    name: string,
    voivodeship: string,
  ) => void;
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

/** Zoom from which gminy borders and AED pins are shown. */
const GMINA_ZOOM = 9;
const MAX_ZOOM = 12;

const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 10_000,
  timeout: 20_000,
};

function geolocationErrorMessage(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) {
    return "Brak zgody na udostępnienie lokalizacji";
  }
  if (error.code === error.TIMEOUT) {
    return "Przekroczono czas oczekiwania na lokalizację";
  }
  return "Nie udało się ustalić lokalizacji";
}

const WEEKDAY_NAMES = ["pon.", "wt.", "śr.", "czw.", "pt.", "sob.", "niedz."] as const;

function formatOpeningHours(aed: AedItem): string {
  if (aed.is_24_7) return "Całodobowo (24/7)";
  if (!aed.opening_hours_simple) return aed.opening_hours_raw ?? "Godziny nieznane";

  const days = [...new Set(aed.opening_hours_simple.days)]
    .sort((a, b) => a - b)
    .map((day) => WEEKDAY_NAMES[day])
    .join(", ");
  return `${days}: ${aed.opening_hours_simple.start}-${aed.opening_hours_simple.end}`;
}

function statusClasses(key: AedStatus["key"]): string {
  if (key === "open_now" || key === "open_24_7") {
    return "bg-emerald-100 text-emerald-800";
  }
  if (key === "closed_now") {
    return "bg-red-100 text-red-800";
  }
  return "bg-slate-100 text-slate-700";
}

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
  const [aedItems, setAedItems] = useState<AedItem[]>([]);
  const [selectedAed, setSelectedAed] = useState<AedItem | null>(null);
  const [selectedLocation, setSelectedLocation] =
    useState<SelectedLocation | null>(null);
  const [aedLoadError, setAedLoadError] = useState<string | null>(null);
  const aedAbortRef = useRef<AbortController | null>(null);
  const aedRequestKeyRef = useRef("");
  const [fetchState, setFetchState] = useState<LoadState>({
    status: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  /** `undefined` = not resolved yet, `null` = outside every gmina (outside Poland). */
  const [userGmina, setUserGmina] = useState<GminaMatch | null | undefined>();
  const [geoState, setGeoState] = useState<GeoState>({ status: "locating" });
  const watchIdRef = useRef<number | null>(null);
  const userLocationRef = useRef<UserLocation | null>(null);
  const zoomOnNextFixRef = useRef(true);

  /** Resolves the user's gmina and (optionally) fits the view to it. */
  const focusUserGmina = useCallback(
    (location: UserLocation, fly: boolean) => {
      loadGminyFeatures()
        .then((features) =>
          findGminaAt(features, location.longitude, location.latitude),
        )
        .catch((error: unknown) => {
          console.error(error);
          return undefined;
        })
        .then((gmina) => {
          if (watchIdRef.current === null) return; // tracking was stopped
          setUserGmina(gmina);
          if (!fly) return;

          const map = mapRef.current?.getMap();
          if (!map) return;
          const camera = gmina
            ? map.cameraForBounds(
                [
                  [gmina.bbox[0], gmina.bbox[1]],
                  [gmina.bbox[2], gmina.bbox[3]],
                ],
                { padding: 48 },
              )
            : undefined;
          map.flyTo({
            center: camera?.center ?? [location.longitude, location.latitude],
            // At least GMINA_ZOOM so the gminy layer and AED pins are visible.
            zoom: Math.min(
              MAX_ZOOM,
              Math.max(GMINA_ZOOM, camera?.zoom ?? GMINA_ZOOM + 1),
            ),
            duration: 1400,
          });
        });
    },
    [],
  );

  const stopWatching = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const startWatching = useCallback(() => {
    if (!window.isSecureContext || !("geolocation" in navigator)) {
      setGeoState({
        status: "error",
        message: window.isSecureContext
          ? "Przeglądarka nie obsługuje geolokalizacji"
          : "Lokalizacja wymaga połączenia HTTPS (lub localhost)",
      });
      return;
    }

    stopWatching();
    zoomOnNextFixRef.current = true;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const location: UserLocation = {
          longitude: position.coords.longitude,
          latitude: position.coords.latitude,
          accuracy: position.coords.accuracy,
        };
        userLocationRef.current = location;
        setUserLocation(location);
        setGeoState({ status: "active" });
        // Zoom only on the first fix — later updates just move the marker.
        const fly = zoomOnNextFixRef.current;
        zoomOnNextFixRef.current = false;
        focusUserGmina(location, fly);
      },
      (error) => {
        // Transient errors while tracking keep the last known position.
        if (
          error.code !== error.PERMISSION_DENIED &&
          userLocationRef.current
        ) {
          return;
        }
        if (error.code === error.PERMISSION_DENIED) {
          stopWatching();
          userLocationRef.current = null;
          setUserLocation(null);
          setUserGmina(undefined);
        }
        setGeoState({
          status: "error",
          message: geolocationErrorMessage(error),
        });
      },
      GEOLOCATION_OPTIONS,
    );
  }, [focusUserGmina, stopWatching]);

  const hideUserLocation = () => {
    stopWatching();
    userLocationRef.current = null;
    setUserLocation(null);
    setUserGmina(undefined);
    setGeoState({ status: "off" });
  };

  const handleLocateClick = () => {
    if (geoState.status === "active" && userLocationRef.current) {
      focusUserGmina(userLocationRef.current, true);
      return;
    }
    setGeoState({ status: "locating" });
    startWatching();
  };

  // Ask for the user's position once on load; the button retries / re-centres.
  useEffect(() => {
    startWatching();
    return stopWatching;
  }, [startWatching, stopWatching]);

  useImperativeHandle(
    ref,
    () => ({
      flyToLocation: (longitude, latitude, name, voivodeship) => {
        setSelectedLocation({ longitude, latitude, name, voivodeship });
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

  useEffect(
    () => () => {
      aedAbortRef.current?.abort();
    },
    [],
  );

  const loadAedMarkers = () => {
    if (!mapRef.current) return;

    const mapZoom = mapRef.current.getZoom();
    if (mapZoom < 9) return;

    const bounds = mapRef.current.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const requestKey = [
      sw.lng.toFixed(4),
      sw.lat.toFixed(4),
      ne.lng.toFixed(4),
      ne.lat.toFixed(4),
    ].join(",");

    if (aedRequestKeyRef.current === requestKey) return;
    aedRequestKeyRef.current = requestKey;
    aedAbortRef.current?.abort();

    const controller = new AbortController();
    aedAbortRef.current = controller;
    setAedLoadError(null);

    fetch(
      `${API_URL}/api/aed?bbox=${[
        sw.lng,
        sw.lat,
        ne.lng,
        ne.lat,
      ].join(",")}`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            response.status === 503
              ? "Baza danych jest niedostępna"
              : `Błąd serwera (${response.status})`,
          );
        }
        return response.json() as Promise<AedListResponse>;
      })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAedItems(
          response.items.filter(
            (item) =>
              Number.isFinite(item.lat) &&
              Number.isFinite(item.lon),
          ),
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAedItems([]);
        setAedLoadError(
          error instanceof Error
            ? error.message
            : "Nie udało się wczytać pinezek",
        );
      });
  };

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
        onMove={(event) => {
          const nextZoom = event.viewState.zoom;
          setZoom(nextZoom);
          if (nextZoom < 9) {
            aedAbortRef.current?.abort();
            aedRequestKeyRef.current = "";
            setAedItems([]);
            setSelectedAed(null);
            setAedLoadError(null);
          }
        }}
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
        onMoveEnd={loadAedMarkers}
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

        {selectedLocation && (
          <Marker
            longitude={selectedLocation.longitude}
            latitude={selectedLocation.latitude}
            anchor="bottom"
          >
            <div
              aria-label={`Wybrano: ${selectedLocation.name}, województwo ${selectedLocation.voivodeship}`}
              className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-sky-600 shadow-[0_4px_14px_rgba(2,132,199,0.45)]"
            >
              <span className="h-3 w-3 rounded-full bg-white" />
            </div>
          </Marker>
        )}

        {selectedLocation && (
          <Popup
            longitude={selectedLocation.longitude}
            latitude={selectedLocation.latitude}
            anchor="top"
            offset={18}
            closeButton={false}
            closeOnClick={false}
            className="commune-popup"
          >
            <div className="px-1 py-0.5">
              <strong className="block text-sm text-slate-900">
                {selectedLocation.name}
              </strong>
              <span className="block text-xs text-slate-600">
                woj. {selectedLocation.voivodeship}
              </span>
            </div>
          </Popup>
        )}

        {zoom >= 9 &&
          aedItems.map((aed) => (
            <Marker
              key={aed.id}
              longitude={aed.lon}
              latitude={aed.lat}
              anchor="bottom"
              onClick={(event) => {
                event.originalEvent.stopPropagation();
                setSelectedAed(aed);
              }}
            >
              <button
                type="button"
                aria-label={`Pokaż dane defibrylatora: ${aed.name}`}
                className={`aed-marker ${aed.status.key === "open_24_7" || aed.status.key === "open_now" ? "aed-marker--available" : ""}`}
              >
                <span aria-hidden="true">AED</span>
              </button>
            </Marker>
          ))}

        {userLocation && (
          <Marker
            longitude={userLocation.longitude}
            latitude={userLocation.latitude}
            anchor="center"
          >
            <div
              role="img"
              aria-label="Twoja lokalizacja"
              title={`Twoja lokalizacja (dokładność ±${Math.round(userLocation.accuracy)} m)`}
              className="user-location-dot"
            />
          </Marker>
        )}

        {selectedAed && zoom >= 9 && (
          <Popup
            longitude={selectedAed.lon}
            latitude={selectedAed.lat}
            anchor="top"
            offset={16}
            closeOnClick={false}
            onClose={() => setSelectedAed(null)}
            className="aed-detail-popup"
            maxWidth="320px"
          >
            <div className="w-[280px] max-w-[calc(100vw-4rem)] px-1 py-1">
              <div className="mb-2 flex items-start justify-between gap-3">
                <strong className="text-sm leading-tight text-slate-950">
                  {selectedAed.name}
                </strong>
                <span
                  className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${statusClasses(selectedAed.status.key)}`}
                >
                  {selectedAed.status.label}
                </span>
              </div>

              <dl className="space-y-1.5 text-xs text-slate-700">
                {(selectedAed.address || selectedAed.city) && (
                  <div>
                    <dt className="font-semibold text-slate-500">Adres</dt>
                    <dd>{selectedAed.address ?? selectedAed.city}</dd>
                  </div>
                )}
                {selectedAed.location_detail && (
                  <div>
                    <dt className="font-semibold text-slate-500">Lokalizacja</dt>
                    <dd>{selectedAed.location_detail}</dd>
                  </div>
                )}
                {selectedAed.gmina_name && (
                  <div>
                    <dt className="font-semibold text-slate-500">Gmina</dt>
                    <dd>{selectedAed.gmina_name}</dd>
                  </div>
                )}
                <div>
                  <dt className="font-semibold text-slate-500">Godziny dostępności</dt>
                  <dd>{formatOpeningHours(selectedAed)}</dd>
                </div>
                {selectedAed.operator && (
                  <div>
                    <dt className="font-semibold text-slate-500">Operator</dt>
                    <dd>{selectedAed.operator}</dd>
                  </div>
                )}
                {selectedAed.access_note && (
                  <div>
                    <dt className="font-semibold text-slate-500">Dostęp</dt>
                    <dd>{selectedAed.access_note}</dd>
                  </div>
                )}
                {selectedAed.locked && (
                  <div className="rounded-md bg-amber-50 px-2 py-1 text-amber-800">
                    Urządzenie może być zabezpieczone / zamknięte
                  </div>
                )}
                {selectedAed.source && (
                  <div className="pt-1 text-[10px] text-slate-400">
                    Źródło: {selectedAed.source}
                  </div>
                )}
              </dl>
            </div>
          </Popup>
        )}

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

      {zoom >= 9 && aedLoadError && (
        <div
          role="alert"
          className="pointer-events-none absolute inset-x-0 top-16 mx-auto w-fit rounded-xl border border-red-200 bg-white/95 px-4 py-2 text-sm text-red-800 shadow-md"
        >
          Nie udało się wczytać pinezek: {aedLoadError}
        </div>
      )}

      {zoom >= 9 && aedLoadError === null && (
        <div className="pointer-events-none absolute right-4 top-16 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs font-semibold text-slate-700 shadow-md">
          Pinezki: {aedItems.length}
        </div>
      )}

      <div className="pointer-events-none absolute bottom-4 left-4 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2">
        {geoState.status === "active" && userGmina && (
          <div
            role="status"
            className="rounded-xl border border-blue-200 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-md"
          >
            Jesteś w gminie{" "}
            <strong className="text-slate-900">{userGmina.name}</strong>
            {loadState.status === "ready" && (
              <span className="block text-slate-500">
                Defibrylatory w gminie: {data.communes?.[userGmina.code] ?? 0}
              </span>
            )}
          </div>
        )}

        {geoState.status === "active" && userGmina === null && (
          <div
            role="status"
            className="rounded-xl border border-amber-200 bg-white/95 px-3 py-2 text-xs text-amber-800 shadow-md"
          >
            Twoja lokalizacja jest poza granicami Polski.
          </div>
        )}

        {geoState.status === "error" && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-white/95 px-3 py-2 text-xs text-red-800 shadow-md"
          >
            {geoState.message}
          </div>
        )}

        <div className="pointer-events-auto flex items-center gap-1">
          <button
            type="button"
            onClick={handleLocateClick}
            disabled={geoState.status === "locating"}
            className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs font-semibold text-slate-700 shadow-md transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-wait disabled:opacity-75"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className={`h-4 w-4 ${geoState.status === "active" ? "text-blue-600" : "text-slate-500"} ${geoState.status === "locating" ? "animate-pulse" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="7" />
              <circle cx="12" cy="12" r="2.5" fill="currentColor" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
            {geoState.status === "locating"
              ? "Ustalanie lokalizacji…"
              : geoState.status === "active"
                ? "Pokaż moją gminę"
                : "Moja lokalizacja"}
          </button>
          {geoState.status === "active" && (
            <button
              type="button"
              onClick={hideUserLocation}
              aria-label="Wyłącz śledzenie lokalizacji"
              title="Wyłącz śledzenie lokalizacji"
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white/95 text-base leading-none text-slate-500 shadow-md transition hover:bg-white hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              ×
            </button>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white/95 px-3 py-2 shadow-md">
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
    </div>
  );
});

export default PolandCommunesMap;

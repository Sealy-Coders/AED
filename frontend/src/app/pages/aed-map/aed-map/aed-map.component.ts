import { isPlatformBrowser, NgClass } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  NgZone,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  FillLayerSpecification,
  GeoJSONFeature,
  LngLatBoundsLike,
  Map as MaplibreMap,
  MapLayerMouseEvent,
  Marker,
  NavigationControl,
  Popup,
} from 'maplibre-gl';
import { of, Subject, Subscription } from 'rxjs';
import { catchError, distinctUntilChanged, map, switchMap } from 'rxjs/operators';

import {
  AdministrativeLevel,
  AedItem,
  AedStatusKey,
  CitySearchTarget,
  DefibrillatorData,
} from '@app/pages/aed-map/aed-map.models';
import {
  COMMUNE_ZOOM,
  COUNTY_ZOOM,
  formatOpeningHours,
  INITIAL_VIEW,
  isAvailable,
  levelForZoom,
  MAP_STYLE_URL,
  MAX_ZOOM,
  MIN_ZOOM,
  RED_COLORS,
  REGIONS_GEOJSON_BASE,
} from '@app/pages/aed-map/aed-map/aed-map.utils';
import { AedBBox, AedService } from '@app/pages/aed-map/aed.service';
import {
  geometryCentroid,
  GMINY_GEOJSON_URL,
  GminaFeature,
  GminaMatch,
  GminyService,
} from '@app/pages/aed-map/gminy.service';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; messageKey: string; params?: Record<string, unknown> }
  | { status: 'ready'; data: DefibrillatorData; total: number };

type GeoState =
  | { status: 'locating' }
  | { status: 'active' }
  | { status: 'off' }
  | { status: 'error'; messageKey: string };

interface UserLocation {
  longitude: number;
  latitude: number;
  /** Radius in metres (GeolocationCoordinates.accuracy). */
  accuracy: number;
}

/** A pin on the map: one AED (zoom >= 9) or a group per województwo/powiat. */
interface AedCluster {
  key: string;
  longitude: number;
  latitude: number;
  count: number;
  item?: AedItem;
  name?: string;
}

type RegionCentroids = Map<string, [number, number, string]>;

const SOURCES = [
  {
    id: 'wojewodztwa',
    level: 'voivodeship',
    data: `${REGIONS_GEOJSON_BASE}/wojewodztwa.json`,
    minzoom: MIN_ZOOM,
    maxzoom: COUNTY_ZOOM,
  },
  {
    id: 'powiaty',
    level: 'county',
    data: `${REGIONS_GEOJSON_BASE}/powiaty.json`,
    minzoom: COUNTY_ZOOM,
    maxzoom: COMMUNE_ZOOM,
  },
  { id: 'gminy', level: 'commune', data: GMINY_GEOJSON_URL, minzoom: COMMUNE_ZOOM, maxzoom: 24 },
] as const;

const BORDER_WIDTH: Record<AdministrativeLevel, number> = { voivodeship: 1.2, county: 0.7, commune: 0.35 };

const GEOLOCATION_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 };

const FILL_PAINT: FillLayerSpecification['paint'] = {
  'fill-color': [
    'interpolate',
    ['linear'],
    ['coalesce', ['feature-state', 'frequency'], 0],
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
  'fill-opacity': 0.82,
};

function supportsWebgl2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

/**
 * AED map: choropleth województwo → powiat → gmina coloured by the number of
 * defibrillators, AED pins (grouped per region when zoomed out), detail popup
 * and live user location zoomed to the user's gmina.
 */
@Component({
  selector: 'app-aed-map',
  standalone: true,
  imports: [TranslatePipe, NgClass],
  templateUrl: './aed-map.component.html',
  styleUrl: './aed-map.component.scss',
  // MapLibre markers/popups live outside Angular's DOM tree
  encapsulation: ViewEncapsulation.None,
})
export class AedMapComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly aedService = inject(AedService);
  private readonly gminyService = inject(GminyService);
  private readonly translate = inject(TranslateService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly mapContainer = viewChild.required<ElementRef<HTMLDivElement>>('mapContainer');
  private readonly aedPopupContent = viewChild.required<ElementRef<HTMLElement>>('aedPopupContent');

  readonly redColors = RED_COLORS;

  readonly zoom = signal(INITIAL_VIEW.zoom);
  readonly level = computed(() => levelForZoom(this.zoom()));
  readonly loadState = signal<LoadState>({ status: 'loading' });
  readonly aedItems = signal<AedItem[]>([]);
  readonly aedLoadErrorKey = signal<string | null>(null);
  readonly selectedAed = signal<AedItem | null>(null);
  readonly userLocation = signal<UserLocation | null>(null);
  /** `undefined` = not resolved yet, `null` = outside every gmina (outside Poland). */
  readonly userGmina = signal<GminaMatch | null | undefined>(undefined);
  readonly geoState = signal<GeoState>({ status: 'locating' });
  /** Set when the MapLibre map cannot be created (e.g. WebGL 2 unavailable). */
  readonly mapErrorKey = signal<string | null>(null);
  readonly userGminaCount = computed(() => {
    const state = this.loadState();
    const gmina = this.userGmina();
    return state.status === 'ready' && gmina ? (state.data.communes[gmina.code] ?? 0) : null;
  });

  private map: MaplibreMap | null = null;
  private mapLoaded = false;
  private regionCentroids: { voivodeships: RegionCentroids; counties: RegionCentroids } = {
    voivodeships: new Map(),
    counties: new Map(),
  };
  private markers: Marker[] = [];
  private userMarker: Marker | null = null;
  private selectedLocationMarker: Marker | null = null;
  private selectedLocationPopup: Popup | null = null;
  private aedPopup: Popup | null = null;
  private hoverPopup: Popup | null = null;
  private watchId: number | null = null;
  private zoomOnNextFix = true;
  private frequenciesSubscription: Subscription | null = null;
  private readonly bboxRequests = new Subject<AedBBox | null>();

  constructor() {
    this.bboxRequests
      .pipe(
        map((bbox) => (bbox ? bbox.map((value) => value.toFixed(4)).join(',') : '')),
        distinctUntilChanged(),
        switchMap((key) => {
          if (!key) {
            return of({ items: [] as AedItem[], errorKey: null as string | null });
          }
          const bbox = key.split(',').map(Number) as AedBBox;
          return this.aedService.getAedList(bbox).pipe(
            map((response) => ({
              items: response.items.filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon)),
              errorKey: null as string | null,
            })),
            catchError((error: unknown) => of({ items: [] as AedItem[], errorKey: this.errorKey(error).messageKey })),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ items, errorKey }) => {
        this.aedItems.set(items);
        this.aedLoadErrorKey.set(errorKey);
        this.renderMarkers();
      });
  }

  ngOnInit(): void {
    if (!this.isBrowser) {
      return;
    }
    this.loadFrequencies();
    this.loadRegionCentroids();
    // Ask for the user's position once on load; the button retries / re-centres.
    this.startWatching();
  }

  ngAfterViewInit(): void {
    if (this.isBrowser) {
      this.zone.runOutsideAngular(() => this.createMap());
    }
  }

  ngOnDestroy(): void {
    this.stopWatching();
    this.frequenciesSubscription?.unsubscribe();
    this.map?.remove();
    this.map = null;
  }

  // ---------------------------------------------------------------------------
  // Public API (used by the page / city search)
  // ---------------------------------------------------------------------------

  flyToLocation(target: CitySearchTarget): void {
    if (!this.map) {
      return;
    }
    this.selectedLocationMarker?.remove();
    this.selectedLocationPopup?.remove();

    const pin = document.createElement('div');
    pin.className = 'aed-map__selected-location';
    pin.setAttribute('role', 'img');
    pin.setAttribute(
      'aria-label',
      `${target.name}, ${this.translate.instant('AedMap.Voivodeship')} ${target.voivodeship}`,
    );
    pin.appendChild(document.createElement('span'));

    const label = document.createElement('div');
    label.className = 'aed-map__popup-text';
    const title = document.createElement('strong');
    title.textContent = target.name;
    const subtitle = document.createElement('span');
    subtitle.textContent = `${this.translate.instant('AedMap.VoivodeshipShort')} ${target.voivodeship}`;
    label.append(title, subtitle);

    this.selectedLocationMarker = new Marker({ element: pin, anchor: 'bottom' })
      .setLngLat([target.longitude, target.latitude])
      .addTo(this.map);
    this.selectedLocationPopup = new Popup({ anchor: 'top', offset: 18, closeButton: false, closeOnClick: false })
      .setLngLat([target.longitude, target.latitude])
      .setDOMContent(label)
      .addTo(this.map);
    this.map.flyTo({ center: [target.longitude, target.latitude], zoom: 10, duration: 1200 });
  }

  retry(): void {
    this.loadState.set({ status: 'loading' });
    this.loadFrequencies();
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  private loadFrequencies(): void {
    this.frequenciesSubscription?.unsubscribe();
    this.frequenciesSubscription = this.aedService.getFrequencies().subscribe({
      next: (response) => {
        this.loadState.set({
          status: 'ready',
          data: {
            voivodeships: response.voivodeships ?? {},
            counties: response.counties ?? {},
            communes: response.communes ?? {},
          },
          total: response.total ?? 0,
        });
        this.applyFeatureState();
        this.renderMarkers();
      },
      error: (error: unknown) => {
        console.error(error);
        this.loadState.set({ status: 'error', ...this.errorKey(error) });
      },
    });
  }

  private errorKey(error: unknown): { messageKey: string; params?: Record<string, unknown> } {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) {
        return { messageKey: 'AedMap.Errors.NoConnection' };
      }
      if (error.status === 503) {
        return { messageKey: 'AedMap.Errors.DatabaseUnavailable' };
      }
      return { messageKey: 'AedMap.Errors.Server', params: { status: error.status } };
    }
    return { messageKey: 'AedMap.Errors.Unknown' };
  }

  /** Centroids of województwa/powiaty - positions of the grouped pins when zoomed out. */
  private loadRegionCentroids(): void {
    const loadRegion = async (url: string, codeLength: number): Promise<RegionCentroids> => {
      const response = await fetch(url);
      if (!response.ok) {
        return new Map();
      }
      const geojson = (await response.json()) as { features?: GminaFeature[] };
      const centers: RegionCentroids = new Map();
      for (const feature of geojson.features ?? []) {
        const code = String(feature.properties?.JPT_KOD_JE ?? '').slice(0, codeLength);
        const center = geometryCentroid(feature);
        if (code && center) {
          centers.set(code, [center[0], center[1], String(feature.properties?.JPT_NAZWA_ ?? '').trim()]);
        }
      }
      return centers;
    };

    Promise.all([loadRegion(SOURCES[0].data, 2), loadRegion(SOURCES[1].data, 4)])
      .then(([voivodeships, counties]) => {
        this.regionCentroids = { voivodeships, counties };
        this.renderMarkers();
      })
      .catch((error: unknown) => console.error(error));
  }

  private requestAedForViewport(): void {
    if (!this.map) {
      return;
    }
    if (this.map.getZoom() < COMMUNE_ZOOM) {
      this.bboxRequests.next(null);
      return;
    }
    const bounds = this.map.getBounds();
    this.bboxRequests.next([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
  }

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------

  private createMap(): void {
    // MapLibre GL 5 renders with WebGL 2 only; without it the constructor throws.
    if (!supportsWebgl2()) {
      this.zone.run(() => this.mapErrorKey.set('AedMap.Errors.WebglUnavailable'));
      return;
    }

    let instance: MaplibreMap;
    try {
      instance = new MaplibreMap({
        container: this.mapContainer().nativeElement,
        style: MAP_STYLE_URL,
        center: INITIAL_VIEW.center,
        zoom: INITIAL_VIEW.zoom,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch (error: unknown) {
      console.error(error);
      this.zone.run(() => this.mapErrorKey.set('AedMap.Errors.MapInit'));
      return;
    }
    instance.touchZoomRotate.disableRotation();
    instance.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    this.map = instance;
    this.hoverPopup = new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
      className: 'aed-map__hover-popup',
    });

    instance.on('load', () => {
      for (const source of SOURCES) {
        instance.addSource(source.id, { type: 'geojson', data: source.data, promoteId: 'JPT_KOD_JE' });
        instance.addLayer({
          id: `${source.id}-fill`,
          type: 'fill',
          source: source.id,
          minzoom: source.minzoom,
          maxzoom: source.maxzoom,
          paint: FILL_PAINT,
        });
        instance.addLayer({
          id: `${source.id}-border`,
          type: 'line',
          source: source.id,
          minzoom: source.minzoom,
          maxzoom: source.maxzoom,
          paint: { 'line-color': '#ffffff', 'line-width': BORDER_WIDTH[source.level], 'line-opacity': 0.85 },
        });
        instance.on('mousemove', `${source.id}-fill`, (event) => this.showHover(event, source.level));
        instance.on('mouseleave', `${source.id}-fill`, () => this.hoverPopup?.remove());
      }
      this.mapLoaded = true;
      this.applyFeatureState();
      this.zone.run(() => this.requestAedForViewport());
    });

    instance.on('zoom', () => {
      const zoom = instance.getZoom();
      if (levelForZoom(zoom) !== this.level()) {
        this.zone.run(() => this.zoom.set(zoom));
        this.renderMarkers();
      }
    });
    instance.on('moveend', () =>
      this.zone.run(() => {
        this.zoom.set(instance.getZoom());
        this.requestAedForViewport();
      }),
    );
  }

  /**
   * Feature ids come from `promoteId: 'JPT_KOD_JE'`, so state is set per TERYT code -
   * this also colours tiles loaded later (pan/zoom). Each source is normalised by its own max.
   */
  private applyFeatureState(): void {
    const state = this.loadState();
    if (!this.map || !this.mapLoaded || state.status !== 'ready') {
      return;
    }
    const byLevel: Record<AdministrativeLevel, Record<string, number>> = {
      voivodeship: state.data.voivodeships,
      county: state.data.counties,
      commune: state.data.communes,
    };
    for (const source of SOURCES) {
      if (!this.map.getSource(source.id)) {
        continue;
      }
      this.map.removeFeatureState({ source: source.id });
      const entries = Object.entries(byLevel[source.level] ?? {});
      const maxCount = Math.max(0, ...entries.map(([, count]) => count));
      if (maxCount === 0) {
        continue;
      }
      for (const [code, count] of entries) {
        this.map.setFeatureState({ source: source.id, id: code }, { frequency: count / maxCount });
      }
    }
  }

  private showHover(event: MapLayerMouseEvent, level: AdministrativeLevel): void {
    const feature: GeoJSONFeature | undefined = event.features?.[0];
    const state = this.loadState();
    if (!feature || !this.map || !this.hoverPopup) {
      return;
    }
    const code = String(feature.properties?.['JPT_KOD_JE'] ?? '');
    const data =
      state.status === 'ready'
        ? level === 'commune'
          ? state.data.communes
          : level === 'county'
            ? state.data.counties
            : state.data.voivodeships
        : {};

    const content = document.createElement('div');
    content.className = 'aed-map__popup-text';
    const title = document.createElement('strong');
    title.textContent = String(feature.properties?.['JPT_NAZWA_'] ?? this.translate.instant(`AedMap.Levels.${level}`));
    const count = document.createElement('span');
    count.textContent = `${this.translate.instant('AedMap.Defibrillators')}: ${data[code] ?? 0}`;
    content.append(title, count);
    this.hoverPopup.setLngLat(event.lngLat).setDOMContent(content).addTo(this.map);
  }

  // ---------------------------------------------------------------------------
  // Pins
  // ---------------------------------------------------------------------------

  private clusters(): AedCluster[] {
    const zoom = this.map?.getZoom() ?? INITIAL_VIEW.zoom;
    if (zoom >= COMMUNE_ZOOM) {
      return this.aedItems().map((item) => ({
        key: item.id,
        longitude: item.lon,
        latitude: item.lat,
        count: 1,
        item,
        name: item.name,
      }));
    }

    // Zoomed out: one group per województwo / powiat, counts from /aed/frequencies
    const state = this.loadState();
    if (state.status !== 'ready') {
      return [];
    }
    const county = zoom >= COUNTY_ZOOM;
    const counts = county ? state.data.counties : state.data.voivodeships;
    const centroids = county ? this.regionCentroids.counties : this.regionCentroids.voivodeships;
    const clusters: AedCluster[] = [];
    for (const [code, count] of Object.entries(counts)) {
      const center = centroids.get(code);
      if (center && count > 0) {
        clusters.push({ key: code, longitude: center[0], latitude: center[1], count, name: center[2] });
      }
    }
    return clusters;
  }

  private renderMarkers(): void {
    if (!this.map) {
      return;
    }
    for (const marker of this.markers) {
      marker.remove();
    }
    const zoom = this.map.getZoom();
    const size = zoom >= COMMUNE_ZOOM ? 38 : zoom >= COUNTY_ZOOM ? 46 : 54;
    this.markers = this.clusters().map((cluster) => this.createPin(cluster, size, zoom).addTo(this.map!));

    const selected = this.selectedAed();
    if (selected && (zoom < COMMUNE_ZOOM || !this.aedItems().some((item) => item.id === selected.id))) {
      this.closeAedPopup();
    }
  }

  private createPin(cluster: AedCluster, size: number, zoom: number): Marker {
    const single = !!cluster.item;
    const red = single && cluster.item!.status.key === 'open_24_7';

    const element = document.createElement('div');
    element.className = 'aed-pin';
    element.style.width = `${size}px`;
    element.style.height = `${size * 0.8}px`;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'aed-pin__button';
    button.setAttribute(
      'aria-label',
      single
        ? this.translate.instant('AedMap.ShowAed', { name: cluster.name })
        : this.translate.instant('AedMap.ZoomToGroup', { name: cluster.name, count: cluster.count }),
    );
    const image = document.createElement('img');
    image.src = red ? 'assets/aed/pin.svg' : 'assets/aed/pin-navy.svg';
    image.alt = '';
    image.draggable = false;
    button.appendChild(image);
    element.appendChild(button);

    if (!single) {
      const label = document.createElement('span');
      label.className = 'aed-pin__label';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = `${cluster.count.toLocaleString('pl-PL')} AED`;
      element.appendChild(label);
    }

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (cluster.item) {
        this.zone.run(() => this.openAedPopup(cluster.item!));
      } else {
        this.map?.flyTo({
          center: [cluster.longitude, cluster.latitude],
          zoom: zoom < COUNTY_ZOOM ? COUNTY_ZOOM : COMMUNE_ZOOM,
          duration: 700,
        });
      }
    });

    return new Marker({ element, anchor: 'bottom' }).setLngLat([cluster.longitude, cluster.latitude]);
  }

  private openAedPopup(aed: AedItem): void {
    if (!this.map) {
      return;
    }
    this.closeAedPopup();
    this.selectedAed.set(aed);
    // render the detail template before MapLibre measures the popup
    this.changeDetector.detectChanges();

    const popup = new Popup({
      anchor: 'top',
      offset: 16,
      closeOnClick: false,
      maxWidth: '320px',
      className: 'aed-map__detail-popup',
    })
      .setLngLat([aed.lon, aed.lat])
      // Angular keeps rendering the template element after MapLibre moves it into the popup
      .setDOMContent(this.aedPopupContent().nativeElement)
      .addTo(this.map);
    // closed by the user (× button) - a popup replaced by another one is detached first
    popup.on('close', () => {
      if (this.aedPopup === popup) {
        this.aedPopup = null;
        this.zone.run(() => this.selectedAed.set(null));
      }
    });
    this.aedPopup = popup;
  }

  private closeAedPopup(): void {
    const popup = this.aedPopup;
    this.aedPopup = null;
    popup?.remove();
    this.selectedAed.set(null);
  }

  openingHours(aed: AedItem): string {
    const dayNames = [0, 1, 2, 3, 4, 5, 6].map((day) => this.translate.instant(`AedMap.Days.${day}`));
    return formatOpeningHours(aed, dayNames, {
      always: this.translate.instant('AedMap.Popup.AlwaysOpen'),
      unknown: this.translate.instant('AedMap.Popup.UnknownHours'),
    });
  }

  statusClass(key: AedStatusKey): string {
    return isAvailable(key) ? 'aed-status--open' : key === 'closed_now' ? 'aed-status--closed' : 'aed-status--unknown';
  }

  // ---------------------------------------------------------------------------
  // User location
  // ---------------------------------------------------------------------------

  locate(): void {
    const location = this.userLocation();
    if (this.geoState().status === 'active' && location) {
      this.focusUserGmina(location, true);
      return;
    }
    this.geoState.set({ status: 'locating' });
    this.startWatching();
  }

  hideUserLocation(): void {
    this.stopWatching();
    this.userMarker?.remove();
    this.userMarker = null;
    this.userLocation.set(null);
    this.userGmina.set(undefined);
    this.geoState.set({ status: 'off' });
  }

  private startWatching(): void {
    if (!window.isSecureContext || !('geolocation' in navigator)) {
      this.geoState.set({
        status: 'error',
        messageKey: window.isSecureContext ? 'AedMap.Location.Unsupported' : 'AedMap.Location.InsecureContext',
      });
      return;
    }

    this.stopWatching();
    this.zoomOnNextFix = true;
    this.watchId = navigator.geolocation.watchPosition(
      (position) =>
        this.zone.run(() => {
          const location: UserLocation = {
            longitude: position.coords.longitude,
            latitude: position.coords.latitude,
            accuracy: position.coords.accuracy,
          };
          this.userLocation.set(location);
          this.geoState.set({ status: 'active' });
          this.renderUserMarker(location);
          // Zoom only on the first fix - later updates just move the marker.
          const fly = this.zoomOnNextFix;
          this.zoomOnNextFix = false;
          this.focusUserGmina(location, fly);
        }),
      (error) =>
        this.zone.run(() => {
          // Transient errors while tracking keep the last known position.
          if (error.code !== error.PERMISSION_DENIED && this.userLocation()) {
            return;
          }
          if (error.code === error.PERMISSION_DENIED) {
            this.stopWatching();
            this.userMarker?.remove();
            this.userMarker = null;
            this.userLocation.set(null);
            this.userGmina.set(undefined);
          }
          this.geoState.set({
            status: 'error',
            messageKey:
              error.code === error.PERMISSION_DENIED
                ? 'AedMap.Location.PermissionDenied'
                : error.code === error.TIMEOUT
                  ? 'AedMap.Location.Timeout'
                  : 'AedMap.Location.Unavailable',
          });
        }),
      GEOLOCATION_OPTIONS,
    );
  }

  private stopWatching(): void {
    if (this.watchId !== null && this.isBrowser) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
  }

  private renderUserMarker(location: UserLocation): void {
    if (!this.map) {
      return;
    }
    const title = this.translate.instant('AedMap.Location.YourLocationAccuracy', {
      accuracy: Math.round(location.accuracy),
    });
    if (!this.userMarker) {
      const dot = document.createElement('div');
      dot.className = 'aed-map__user-location';
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', this.translate.instant('AedMap.Location.YourLocation'));
      this.userMarker = new Marker({ element: dot, anchor: 'center' });
    }
    this.userMarker.getElement().title = title;
    this.userMarker.setLngLat([location.longitude, location.latitude]).addTo(this.map);
  }

  /** Resolves the user's gmina and (optionally) fits the view to it. */
  private focusUserGmina(location: UserLocation, fly: boolean): void {
    this.gminyService
      .load()
      .then((gminy) => this.gminyService.findGminaAt(gminy.features, location.longitude, location.latitude))
      .catch((error: unknown) => {
        console.error(error);
        return undefined;
      })
      .then((gmina) => {
        if (this.watchId === null) {
          return; // tracking was stopped
        }
        this.userGmina.set(gmina);
        if (!fly || !this.map) {
          return;
        }
        const camera = gmina
          ? this.map.cameraForBounds(
              [
                [gmina.bbox[0], gmina.bbox[1]],
                [gmina.bbox[2], gmina.bbox[3]],
              ] as LngLatBoundsLike,
              { padding: 48 },
            )
          : undefined;
        this.map.flyTo({
          center: camera?.center ?? [location.longitude, location.latitude],
          // At least COMMUNE_ZOOM so the gminy layer and AED pins are visible.
          zoom: Math.min(MAX_ZOOM, Math.max(COMMUNE_ZOOM, camera?.zoom ?? COMMUNE_ZOOM + 1)),
          duration: 1400,
        });
      });
  }
}

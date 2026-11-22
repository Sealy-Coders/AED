import { AdministrativeLevel, AedItem, AedStatusKey } from '@app/pages/aed-map/aed-map.models';

/** Zoom from which gminy borders and individual AED pins are shown. */
export const COMMUNE_ZOOM = 9;
/** Zoom from which powiaty are shown. */
export const COUNTY_ZOOM = 7;
export const MIN_ZOOM = 5;
export const MAX_ZOOM = 12;
export const INITIAL_VIEW = { center: [19.2, 52.1] as [number, number], zoom: 5.7 };

export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
export const REGIONS_GEOJSON_BASE =
  'https://raw.githubusercontent.com/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy/main';

export const RED_COLORS = ['#fee2e2', '#fecaca', '#fca5a5', '#f87171', '#ef4444', '#b91c1c'] as const;

export const VOIVODESHIPS: Record<string, string> = {
  '02': 'dolnośląskie',
  '04': 'kujawsko-pomorskie',
  '06': 'lubelskie',
  '08': 'lubuskie',
  '10': 'łódzkie',
  '12': 'małopolskie',
  '14': 'mazowieckie',
  '16': 'opolskie',
  '18': 'podkarpackie',
  '20': 'podlaskie',
  '22': 'pomorskie',
  '24': 'śląskie',
  '26': 'świętokrzyskie',
  '28': 'warmińsko-mazurskie',
  '30': 'wielkopolskie',
  '32': 'zachodniopomorskie',
};

export function levelForZoom(zoom: number): AdministrativeLevel {
  return zoom >= COMMUNE_ZOOM ? 'commune' : zoom >= COUNTY_ZOOM ? 'county' : 'voivodeship';
}

export function isAvailable(key: AedStatusKey): boolean {
  return key === 'open_now' || key === 'open_24_7';
}

/**
 * Opening hours for the detail popup, e.g. "pon., wt., śr.: 08:00-16:00".
 * `dayNames` are indexed Monday = 0 … Sunday = 6.
 */
export function formatOpeningHours(
  aed: AedItem,
  dayNames: string[],
  labels: { always: string; unknown: string },
): string {
  if (aed.is_24_7) {
    return labels.always;
  }
  if (!aed.opening_hours_simple) {
    return aed.opening_hours_raw ?? labels.unknown;
  }
  const days = [...new Set(aed.opening_hours_simple.days)]
    .sort((a, b) => a - b)
    .map((day) => dayNames[day] ?? String(day))
    .join(', ');
  return `${days}: ${aed.opening_hours_simple.start}-${aed.opening_hours_simple.end}`;
}

export function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase('pl-PL')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0142/g, 'l');
}

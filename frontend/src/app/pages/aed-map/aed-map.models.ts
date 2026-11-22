/** AED counts keyed by TERYT code (województwo: 2, powiat: 4, gmina: 7 digits). */
export interface DefibrillatorData {
  voivodeships: Record<string, number>;
  counties: Record<string, number>;
  communes: Record<string, number>;
}

/** Response of `GET /aed/frequencies`. */
export interface AedFrequenciesResponse extends DefibrillatorData {
  total: number;
  unassigned: number;
}

export type AedStatusKey = 'open_24_7' | 'open_now' | 'closed_now' | 'unknown';

export interface AedStatus {
  key: AedStatusKey;
  label: string;
  badge: AedStatusKey;
}

export interface AedOpeningHoursSimple {
  /** `Date#getDay()`-independent weekday numbers: Monday = 0 … Sunday = 6 */
  days: number[];
  start: string;
  end: string;
}

export interface AedItem {
  id: string;
  name: string;
  lat: number;
  lon: number;
  teryt_gmina: string | null;
  gmina_name: string | null;
  address: string | null;
  city: string | null;
  location_detail: string | null;
  placement: string | null;
  cabinet: string | null;
  access_note: string | null;
  is_24_7: boolean;
  opening_hours_simple: AedOpeningHoursSimple | null;
  opening_hours_raw: string | null;
  pediatric_mode: boolean | null;
  last_verified: string | null;
  locked: boolean;
  operator: string | null;
  source: string | null;
  status: AedStatus;
}

/** Response of `GET /aed?bbox=…`. */
export interface AedListResponse {
  items: AedItem[];
  count: number;
}

export type AdministrativeLevel = 'voivodeship' | 'county' | 'commune';

/** A city/gmina search result (gmina centroid). */
export interface CitySearchTarget {
  name: string;
  voivodeship: string;
  code: string;
  longitude: number;
  latitude: number;
}

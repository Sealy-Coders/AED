import { AedItem } from '@app/pages/aed-map/aed-map.models';
import {
  formatOpeningHours,
  isAvailable,
  levelForZoom,
  normalizeSearchText,
} from '@app/pages/aed-map/aed-map/aed-map.utils';

const DAYS = ['pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.', 'niedz.'];
const LABELS = { always: 'Całodobowo (24/7)', unknown: 'Godziny nieznane' };

function aed(overrides: Partial<AedItem>): AedItem {
  return {
    id: 'aed-1',
    name: 'AED',
    lat: 52.2,
    lon: 21,
    teryt_gmina: null,
    gmina_name: null,
    address: null,
    city: null,
    location_detail: null,
    placement: null,
    cabinet: null,
    access_note: null,
    is_24_7: false,
    opening_hours_simple: null,
    opening_hours_raw: null,
    pediatric_mode: null,
    last_verified: null,
    locked: false,
    operator: null,
    source: null,
    status: { key: 'unknown', label: 'Nieznany status', badge: 'unknown' },
    ...overrides,
  };
}

describe('aed-map utils', () => {
  it('maps zoom to the administrative level', () => {
    expect(levelForZoom(5.7)).toBe('voivodeship');
    expect(levelForZoom(7)).toBe('county');
    expect(levelForZoom(8.99)).toBe('county');
    expect(levelForZoom(9)).toBe('commune');
  });

  it('treats 24/7 and open now as available', () => {
    expect(isAvailable('open_24_7')).toBe(true);
    expect(isAvailable('open_now')).toBe(true);
    expect(isAvailable('closed_now')).toBe(false);
    expect(isAvailable('unknown')).toBe(false);
  });

  it('formats opening hours', () => {
    expect(formatOpeningHours(aed({ is_24_7: true }), DAYS, LABELS)).toBe('Całodobowo (24/7)');
    expect(formatOpeningHours(aed({}), DAYS, LABELS)).toBe('Godziny nieznane');
    expect(formatOpeningHours(aed({ opening_hours_raw: 'by appointment' }), DAYS, LABELS)).toBe('by appointment');
    expect(
      formatOpeningHours(
        aed({ opening_hours_simple: { days: [4, 0, 0, 1], start: '08:00', end: '16:00' } }),
        DAYS,
        LABELS,
      ),
    ).toBe('pon., wt., pt.: 08:00-16:00');
  });

  it('normalizes Polish text for search', () => {
    expect(normalizeSearchText('Łódź')).toBe('lodz');
    expect(normalizeSearchText('ŚWIĘTOCHŁOWICE')).toBe('swietochlowice');
  });
});

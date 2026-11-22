import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { geometryCentroid, GminaFeature, GminyService, polygonContains } from '@app/pages/aed-map/gminy.service';

function square(code: string, name: string, x0: number, y0: number, hole?: number[][]): GminaFeature {
  const rings = [
    [
      [x0, y0],
      [x0 + 1, y0],
      [x0 + 1, y0 + 1],
      [x0, y0 + 1],
      [x0, y0],
    ],
  ];
  if (hole) {
    rings.push(hole);
  }
  return {
    type: 'Feature',
    properties: { JPT_KOD_JE: code, JPT_NAZWA_: name },
    geometry: { type: 'Polygon', coordinates: rings },
  };
}

const HOLE = [
  [20.4, 52.4],
  [20.6, 52.4],
  [20.6, 52.6],
  [20.4, 52.6],
  [20.4, 52.4],
];

describe('GminyService', () => {
  let service: GminyService;
  const http = { get: jest.fn() };

  beforeEach(() => {
    http.get.mockReset();
    TestBed.configureTestingModule({ providers: [GminyService, { provide: HttpClient, useValue: http }] });
    service = TestBed.inject(GminyService);
  });

  it('finds the gmina containing a point, honouring holes', () => {
    const features = [square('1465011', 'Warszawa', 20, 52, HOLE), square('1201011', 'Inna', 21, 52)];
    expect(service.findGminaAt(features, 20.2, 52.2)).toEqual({
      code: '1465011',
      name: 'Warszawa',
      bbox: [20, 52, 21, 53],
    });
    expect(service.findGminaAt(features, 21.5, 52.2)?.code).toBe('1201011');
    expect(service.findGminaAt(features, 20.5, 52.5)).toBeNull();
    expect(service.findGminaAt(features, 13.4, 52.5)).toBeNull();
  });

  it('loads the GeoJSON once and retries after a failure', async () => {
    http.get.mockReturnValueOnce(throwError(() => new Error('offline')));
    await expect(service.load()).rejects.toThrow('offline');

    const collection = { type: 'FeatureCollection', features: [square('1465011', 'Warszawa', 20, 52)] };
    http.get.mockReturnValue(of(collection));
    await expect(service.load()).resolves.toBe(collection);
    await service.load();
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  it('computes centroids and point-in-polygon', () => {
    expect(geometryCentroid(square('1', 'a', 20, 52))).toEqual([20.4, 52.4]);
    expect(polygonContains(square('1', 'a', 20, 52).geometry.coordinates as number[][][], 20.5, 52.5)).toBe(true);
  });
});

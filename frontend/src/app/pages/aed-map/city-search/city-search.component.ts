import { Component, computed, inject, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';

import { CitySearchTarget } from '@app/pages/aed-map/aed-map.models';
import { normalizeSearchText, VOIVODESHIPS } from '@app/pages/aed-map/aed-map/aed-map.utils';
import { geometryCentroid, GminyService } from '@app/pages/aed-map/gminy.service';

const MAX_SUGGESTIONS = 8;

interface IndexedCity extends CitySearchTarget {
  normalizedName: string;
}

/** Search box over gmina names (from the bundled gminy GeoJSON). */
@Component({
  selector: 'app-aed-city-search',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: './city-search.component.html',
  styleUrl: './city-search.component.scss',
})
export class CitySearchComponent implements OnInit {
  private readonly gminyService = inject(GminyService);

  readonly citySelected = output<CitySearchTarget>();

  readonly query = signal('');
  readonly loading = signal(true);
  readonly loadFailed = signal(false);
  private readonly cities = signal<IndexedCity[]>([]);

  readonly suggestions = computed(() => {
    const query = normalizeSearchText(this.query().trim());
    if (!query) {
      return [];
    }
    return this.cities()
      .map((city) => ({
        city,
        score:
          city.normalizedName === query
            ? 0
            : city.normalizedName.startsWith(query)
              ? 1
              : city.normalizedName.includes(query)
                ? 2
                : 3,
      }))
      .filter(({ score }) => score < 3)
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.city.name.localeCompare(right.city.name, 'pl') ||
          left.city.voivodeship.localeCompare(right.city.voivodeship, 'pl'),
      )
      .slice(0, MAX_SUGGESTIONS)
      .map(({ city }) => city);
  });

  ngOnInit(): void {
    this.gminyService
      .load()
      .then((gminy) => {
        const cities: IndexedCity[] = [];
        for (const feature of gminy.features) {
          const code = String(feature.properties?.JPT_KOD_JE ?? '');
          const name = String(feature.properties?.JPT_NAZWA_ ?? '').trim();
          const center = geometryCentroid(feature);
          if (!code || !name || !center) {
            continue;
          }
          cities.push({
            name,
            code,
            voivodeship: VOIVODESHIPS[code.slice(0, 2)] ?? '?',
            longitude: center[0],
            latitude: center[1],
            normalizedName: normalizeSearchText(name),
          });
        }
        this.cities.set(cities);
      })
      .catch((error: unknown) => {
        console.error(error);
        this.loadFailed.set(true);
      })
      .finally(() => this.loading.set(false));
  }

  select(city: CitySearchTarget): void {
    this.citySelected.emit(city);
  }
}

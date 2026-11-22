import { Component, inject, OnInit, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

import { CitySearchTarget } from '@app/pages/aed-map/aed-map.models';
import { AedMapComponent } from '@app/pages/aed-map/aed-map/aed-map.component';
import { CitySearchComponent } from '@app/pages/aed-map/city-search/city-search.component';
import { SeoService } from '@app/services/seo.service';

/** `/pl/aed` - map of AED defibrillators in Poland. */
@Component({
  selector: 'app-aed-map-page',
  standalone: true,
  imports: [TranslatePipe, AedMapComponent, CitySearchComponent],
  templateUrl: './aed-map-page.component.html',
  styleUrl: './aed-map-page.component.scss',
})
export class AedMapPageComponent implements OnInit {
  private readonly seoService = inject(SeoService);
  private readonly map = viewChild.required(AedMapComponent);

  ngOnInit(): void {
    this.seoService.setPageTitleByTranslationKey(['AedMap.Title']);
  }

  onCitySelected(target: CitySearchTarget): void {
    this.map().flyToLocation(target);
  }
}

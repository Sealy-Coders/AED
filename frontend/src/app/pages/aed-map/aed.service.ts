import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Inject, Injectable, PLATFORM_ID } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { CookieService } from 'ngx-cookie-service';
import { LocalStorageService } from 'ngx-localstorage';
import { Observable } from 'rxjs';

import { AedFrequenciesResponse, AedItem, AedListResponse } from '@app/pages/aed-map/aed-map.models';
import { ApiConfig } from '@app/services/api';
import { LoginService } from '@app/services/login-service';
import { NotificationsService } from '@app/services/notifications.service';
import { RestService } from '@app/services/rest.service';

/** [min_lon, min_lat, max_lon, max_lat] */
export type AedBBox = [number, number, number, number];

/**
 * AED map API (`/aed`, served by the `mcod.aed` backend app).
 */
@Injectable({
  providedIn: 'root',
})
export class AedService extends RestService {
  constructor(
    protected http: HttpClient,
    public translate: TranslateService,
    public router: Router,
    public notificationService: NotificationsService,
    public storageService: LocalStorageService,
    public cookieService: CookieService,
    public loginService: LoginService,
    @Inject(DOCUMENT) public document: Document,
    @Inject(PLATFORM_ID) public platformId: string,
  ) {
    super(
      http,
      translate,
      router,
      notificationService,
      storageService,
      cookieService,
      loginService,
      document,
      platformId,
    );
  }

  /** AED counts per województwo / powiat / gmina. */
  getFrequencies(): Observable<AedFrequenciesResponse> {
    return this.get(ApiConfig.aedFrequencies, undefined, true);
  }

  /** AED points inside the bounding box, with their live open status. */
  getAedList(bbox: AedBBox, onlyOpenNow = false): Observable<AedListResponse> {
    const params: Record<string, string> = { bbox: bbox.join(',') };
    if (onlyOpenNow) {
      params['only_open_now'] = 'true';
    }
    return this.get(ApiConfig.aed, params, true);
  }

  getAed(id: string): Observable<AedItem> {
    return this.get(`${ApiConfig.aed}/${encodeURIComponent(id)}`, undefined, true);
  }
}

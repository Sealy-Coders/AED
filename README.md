# Otwarte Dane + mapa defibrylatorów AED

Repozytorium zawiera kod portalu **dane.gov.pl** (Otwarte Dane) z dodaną podstroną
**Mapa defibrylatorów AED** (`/pl/aed`, `/en/aed`).

| Katalog     | Zawartość                                                                                                      |
|-------------|----------------------------------------------------------------------------------------------------------------|
| `backend/`  | Backend portalu: Python 3.8, Django 2.2, API w Falcon, Postgres, Elasticsearch, Celery, CMS Wagtail. Aplikacja `mcod.aed` — dane i API mapy AED. |
| `frontend/` | Frontend portalu: Angular 18. Podstrona `src/app/pages/aed-map` — mapa AED (MapLibre GL).                      |

Wcześniejsza, samodzielna wersja mapy (Next.js + FastAPI + MongoDB) została przeniesiona do tych
technologii i jest dostępna w historii gita (gałąź `main`).

## Uruchomienie

Wymagania: Docker (Docker Desktop), Node.js ≥ 20 (np. przez `nvm`), `python3`, `curl`.

Jednorazowo dodaj domeny lokalne do `/etc/hosts` (przy Docker Desktop adres `127.0.0.1`):

```shell
echo "127.0.0.1 mcod.local api.mcod.local admin.mcod.local cms.mcod.local forum.mcod.local mail.mcod.local" | sudo tee -a /etc/hosts
```

Potem z katalogu głównego repozytorium:

```shell
./start.sh init   # jednorazowo: migracje + dane startowe portalu + dane AED
./start.sh        # backend (Docker) + frontend; Ctrl+C zatrzymuje oba
./start.sh stop   # zatrzymanie backendu (np. po KEEP_BACKEND=1 ./start.sh)
```

`start.sh` przy braku tworzy `backend/.env` (z `env.sample`, z nowym kluczem `FIELD_ENCRYPTION_KEYS`) i
`backend/mcod/settings/local.py`, sprawdza wpisy w `/etc/hosts`, przełącza Node przez `nvm`, w razie potrzeby
wykonuje `npm ci`, uruchamia usługi backendu (bez Discourse, Fuseki i mailhoga), czeka na API i startuje `ng serve`.
Obrazy Dockera budują się przy pierwszym uruchomieniu (kilkanaście minut).

Podstrona AED: `http://localhost:4200/pl/aed`.

Gdy podsieć `172.18.18.0/24` lub port 80 są zajęte, ustaw w `backend/.env` `MCOD_DOCKER_NETWORK_PREFIX`
i `MCOD_NGINX_HTTP_PORT` (zob. [`backend/README.md`](backend/README.md)). Szczegółowe instrukcje ręcznego
uruchamiania: [`backend/README.md`](backend/README.md) (sekcja „Mapa defibrylatorów AED”) oraz
[`frontend/README.md`](frontend/README.md).

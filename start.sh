#!/usr/bin/env bash
#
# Uruchamia całe środowisko lokalne: usługi backendu (Docker) + frontend (ng serve).
#
#   ./start.sh          start backendu i frontendu; Ctrl+C zatrzymuje oba
#   ./start.sh init     jednorazowo: migracje + dane startowe portalu + dane AED
#   ./start.sh stop     zatrzymanie usług backendu
#
# Zmienne:
#   KEEP_BACKEND=1      nie zatrzymuj backendu po Ctrl+C
#   HOSTS_FILE=…        plik sprawdzany pod kątem wpisów *.mcod.local (domyślnie /etc/hosts)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"

# Bez Discourse (obraz z prywatnego rejestru), Fuseki i mailhoga - mapa AED i API ich nie potrzebują.
SERVICES=(mcod-db mcod-redis mcod-rabbitmq mcod-elasticsearch mcod-local-api mcod-nginx)
DOMAINS=(mcod.local api.mcod.local admin.mcod.local cms.mcod.local forum.mcod.local mail.mcod.local)
API_WAIT_SECONDS=180

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mBłąd:\033[0m %s\n' "$*" >&2
  exit 1
}

compose() { docker compose -f "$BACKEND/docker-compose.local.yml" "$@"; }

https_port() {
  local port
  port="$(sed -n 's/^MCOD_NGINX_HTTPS_PORT=\([0-9]*\).*/\1/p' "$BACKEND/.env" | tail -n 1)"
  echo "${port:-443}"
}

check_docker() {
  command -v docker >/dev/null || die "Brak polecenia docker."
  docker info >/dev/null 2>&1 ||
    die "Docker nie działa. Uruchom Docker Desktop (np. 'systemctl --user start docker-desktop') i spróbuj ponownie."
}

ensure_backend_config() {
  if [[ ! -f "$BACKEND/.env" ]]; then
    info "Tworzę backend/.env z env.sample (nowy FIELD_ENCRYPTION_KEYS, Discourse wyłączony)"
    local key
    key="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    sed -e "s/^FIELD_ENCRYPTION_KEYS=.*/FIELD_ENCRYPTION_KEYS=$key/" \
      -e 's/^DISCOURSE_FORUM_ENABLED=.*/DISCOURSE_FORUM_ENABLED=false/' \
      "$BACKEND/env.sample" >"$BACKEND/.env"
    warn "Sprawdź w backend/.env MCOD_DOCKER_NETWORK_PREFIX i MCOD_NGINX_HTTP_PORT (konflikty podsieci / portu 80)."
  fi
  if [[ ! -f "$BACKEND/mcod/settings/local.py" ]]; then
    info "Tworzę backend/mcod/settings/local.py z local.py.sample"
    cp "$BACKEND/mcod/settings/local.py.sample" "$BACKEND/mcod/settings/local.py"
  fi
}

check_hosts() {
  local missing=()
  for domain in "${DOMAINS[@]}"; do
    grep -qE "^[^#]*[[:space:]]${domain//./\\.}([[:space:]]|$)" "$HOSTS_FILE" 2>/dev/null || missing+=("$domain")
  done
  if ((${#missing[@]})); then
    die "Brak wpisów w $HOSTS_FILE dla: ${missing[*]}
Dodaj je (Docker Desktop: adres 127.0.0.1, bo nginx wystawia port na hoście):

  echo \"127.0.0.1 ${DOMAINS[*]}\" | sudo tee -a /etc/hosts
"
  fi
}

ensure_node() {
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    set +u && source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use && set -u
    if ! nvm use 22 >/dev/null 2>&1 && ! nvm use 20 >/dev/null 2>&1; then
      warn "nvm nie ma Node 20/22 - instalacja: nvm install 22"
    fi
  fi
  command -v node >/dev/null || die "Brak Node.js (wymagany >= 20)."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  ((major >= 20)) || die "Node $(node -v) jest za stary - wymagany >= 20 (np. 'nvm install 22')."
  info "Node $(node -v)"
}

ensure_node_modules() {
  local stamp="$FRONTEND/node_modules/.package-lock.json"
  if [[ ! -d "$FRONTEND/node_modules/@angular/core" || ! -f "$stamp" || "$FRONTEND/package-lock.json" -nt "$stamp" ]]; then
    info "Instaluję zależności frontendu (npm ci)…"
    (cd "$FRONTEND" && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund)
  fi
}

start_backend() {
  info "Uruchamiam usługi backendu: ${SERVICES[*]}"
  compose up -d --no-deps "${SERVICES[@]}"
}

wait_for_api() {
  local port url
  port="$(https_port)"
  url="https://api.mcod.local:$port/ping"
  info "Czekam na API ($url)…"
  for ((i = 0; i < API_WAIT_SECONDS; i += 3)); do
    # --resolve: działa także bez wpisu w /etc/hosts
    if curl -sk --max-time 3 --resolve "api.mcod.local:$port:127.0.0.1" -o /dev/null -w '%{http_code}' "$url" | grep -q '^200$'; then
      info "API działa."
      return 0
    fi
    sleep 3
  done
  die "API nie odpowiada po ${API_WAIT_SECONDS}s. Logi: docker compose -f backend/docker-compose.local.yml logs mcod-local-api mcod-nginx"
}

stop_backend() {
  info "Zatrzymuję usługi backendu…"
  compose stop "${SERVICES[@]}" >/dev/null 2>&1 || true
}

manage() { compose run --rm --no-deps -T mcod-local-api python manage.py "$@"; }

# init_mcod_db loads fixtures with fixed users and fails on a database that already has them.
db_initialized() {
  manage shell -c "
from django.db import connection
from mcod.users.models import User
ready = User._meta.db_table in connection.introspection.table_names() and User.objects.exists()
print('DB_INITIALIZED' if ready else 'DB_EMPTY')
" 2>/dev/null | grep -q DB_INITIALIZED
}

cmd_init() {
  check_docker
  ensure_backend_config
  compose up -d --no-deps mcod-db mcod-redis mcod-rabbitmq mcod-elasticsearch
  info "Czekam na Postgresa…"
  local i
  for ((i = 0; i < 60; i++)); do
    compose exec -T mcod-db pg_isready -q >/dev/null 2>&1 && break
    sleep 2
  done
  compose exec -T mcod-db pg_isready -q >/dev/null 2>&1 || die "Postgres nie odpowiada (docker compose -f backend/docker-compose.local.yml logs mcod-db)."
  if db_initialized; then
    info "Baza jest już zainicjalizowana - wykonuję tylko migracje…"
    manage migrate
  else
    info "Migracje i dane startowe portalu (init_mcod_db)…"
    manage init_mcod_db
  fi
  info "Dane AED (seed_aed z data/aed/aed_scraped.json)…"
  manage seed_aed --input data/aed/aed_scraped.json
  info "Gotowe. Uruchom: ./start.sh"
}

cmd_start() {
  check_docker
  ensure_backend_config
  check_hosts
  ensure_node
  ensure_node_modules
  start_backend

  cleanup_done=0
  cleanup() {
    ((cleanup_done)) && return
    cleanup_done=1
    if [[ "${KEEP_BACKEND:-0}" == "1" ]]; then
      info "Backend zostaje uruchomiony (KEEP_BACKEND=1). Zatrzymanie: ./start.sh stop"
    else
      stop_backend
    fi
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  wait_for_api
  info "Frontend: http://localhost:4200/pl/aed  (Ctrl+C zatrzymuje frontend i backend)"
  (cd "$FRONTEND" && npm run start:local)
}

case "${1:-start}" in
  start) cmd_start ;;
  init) cmd_init ;;
  stop)
    check_docker
    stop_backend
    ;;
  -h | --help | help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "Nieznane polecenie: $1 (dostępne: start, init, stop)" ;;
esac

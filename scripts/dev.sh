#!/usr/bin/env bash
# Local development: run all services + gateway + web on the host with hot reload, against the infra
# stack (docker-compose.infra.yml: Mongo :27018, Redis :6379, MinIO :9000, Mailpit :8025).
#
#   npm run dev                 # everything
#   npm run dev -- identity web # only the listed apps (identity marketplace orders payments delivery
#                               #   notifications gateway web)
#
# Reads .env (created from .env.example on first run). Services: http://localhost:4001..4006,
# gateway http://localhost:8080, web (Vite) http://localhost:5173. Ctrl-C stops everything.
# For the containerized full stack use `npm run stack:up` instead (do not run both: same host ports).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "dev: created .env from .env.example (demo defaults)"
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# (bash 3.2 compatible: macOS ships bash 3.2, no associative arrays)
port_of() {
  case "$1" in
    identity) echo 4001 ;; marketplace) echo 4002 ;; orders) echo 4003 ;; payments) echo 4004 ;;
    delivery) echo 4005 ;; notifications) echo 4006 ;; gateway) echo 8080 ;;
  esac
}
ALL=(identity marketplace orders payments delivery notifications gateway web)
if [ "$#" -gt 0 ]; then APPS=("$@"); else APPS=("${ALL[@]}"); fi
for a in "${APPS[@]}"; do
  [[ " ${ALL[*]} " == *" $a "* ]] || { echo "dev: unknown app '$a' (known: ${ALL[*]})" >&2; exit 2; }
done

echo "dev: starting infra stack (docker-compose.infra.yml)"
docker compose -f docker-compose.infra.yml up -d --wait

# Services import the shared packages through their package.json exports (dist): build them once.
echo "dev: building shared packages (contracts, pricing, service-kit)"
npx tsc -b packages/contracts packages/pricing packages/service-kit

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "dev: stopping"
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

prefix() { local tag="$1"; while IFS= read -r line; do printf '%-14s| %s\n' "$tag" "$line"; done; }

for a in "${APPS[@]}"; do
  if [ "$a" = web ]; then
    (npm run dev -w @thali/web 2>&1 | prefix web) &
  else
    (SERVICE_NAME="$a" PORT="$(port_of "$a")" npm run dev -w "@thali/$a" 2>&1 | prefix "$a") &
  fi
  PIDS+=("$!")
done

echo "dev: running ${APPS[*]} (Ctrl-C to stop)"
wait

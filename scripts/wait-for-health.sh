#!/usr/bin/env bash
# Wait until the full docker stack (docker-compose.yml, project `thali`) is healthy.
#
#   scripts/wait-for-health.sh [timeout_seconds]      (default 300)
#
# Passes when every long-running container reports health=healthy and every one-shot job
# (mongo-init, minio-init) exited 0; then probes the published gateway and web ports from the host.
# Exits 1 on timeout, on a failed one-shot job, or on an unhealthy/exited container (prints its logs).
set -euo pipefail
cd "$(dirname "$0")/.."

TIMEOUT="${1:-300}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
GATEWAY="http://localhost:${GATEWAY_HOST_PORT:-8080}"
WEB="http://localhost:${WEB_HOST_PORT:-5173}"
ONESHOT=" mongo-init minio-init "

deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  pending=()
  failed=()
  rows="$(docker compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}')"
  if [ -z "$rows" ]; then
    echo "wait-for-health: no containers in project (run: npm run stack:up)" >&2
    exit 1
  fi
  while IFS='|' read -r svc state health code; do
    [ -z "$svc" ] && continue
    if [[ "$ONESHOT" == *" $svc "* ]]; then
      if [ "$state" = exited ]; then
        [ "$code" = 0 ] || failed+=("$svc(exit $code)")
      else
        pending+=("$svc($state)")
      fi
      continue
    fi
    case "$state/$health" in
      running/healthy) ;;
      exited/* | dead/*) failed+=("$svc($state, exit $code)") ;;
      *) pending+=("$svc($state${health:+/$health})") ;;
    esac
  done <<< "$rows"

  if [ "${#failed[@]}" -gt 0 ]; then
    echo "wait-for-health: FAILED: ${failed[*]}" >&2
    for f in "${failed[@]}"; do docker compose logs --tail 40 "${f%%(*}" >&2 || true; done
    exit 1
  fi
  [ "${#pending[@]}" -eq 0 ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "wait-for-health: TIMEOUT after ${TIMEOUT}s; not healthy: ${pending[*]}" >&2
    exit 1
  fi
  echo "wait-for-health: waiting for ${pending[*]}"
  sleep 3
done

echo "wait-for-health: all containers healthy"
curl -fsS -o /dev/null "$GATEWAY/health/ready" && echo "  gateway $GATEWAY/health/ready OK"
curl -fsS -o /dev/null "$GATEWAY/api/v1/meta" && echo "  gateway $GATEWAY/api/v1/meta OK"
curl -fsS -o /dev/null "$WEB/" && echo "  web $WEB/ OK"

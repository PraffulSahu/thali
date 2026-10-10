#!/usr/bin/env bash
# Write a .env with fresh random secrets (for anything other than the local demo).
#
#   scripts/gen-env.sh [output-file] [--force]        (default output: .env)
#
# Starts from .env.example and replaces every demo placeholder secret (values carrying the `thali-demo-`
# marker, which APP_MODE=production refuses) with `openssl rand` output:
#   FIELD_ENCRYPTION_KEY -> base64 of 32 random bytes; every other secret -> 32 random bytes as hex
#   (hex keeps Mongo passwords URL-safe inside connection URIs).
# Nothing else changes: afterwards set APP_MODE, real providers (Razorpay/Twilio/Resend/Google), turn
# DEMO_OTP_ENABLED off and empty DEMO_PHONES for sandbox/production. Refuses to overwrite without --force.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=".env"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) OUT="$arg" ;;
  esac
done
command -v openssl >/dev/null || { echo "gen-env: openssl is required" >&2; exit 1; }
[ -f .env.example ] || { echo "gen-env: .env.example not found" >&2; exit 1; }
if [ -e "$OUT" ] && [ "$FORCE" -ne 1 ]; then
  echo "gen-env: $OUT exists (use --force to overwrite)" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
count=0
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^([A-Z0-9_]+)=([^[:space:]#]*)(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"; rest="${BASH_REMATCH[3]}"
    decoded=""
    if [ "$key" = "FIELD_ENCRYPTION_KEY" ] && [ -n "$value" ]; then
      decoded="$(printf '%s' "$value" | openssl base64 -d -A 2>/dev/null | head -c 11 || true)"
    fi
    if [[ "$value" == *thali-demo-* || "$decoded" == "thali-demo-" ]]; then
      if [ "$key" = "FIELD_ENCRYPTION_KEY" ]; then
        value="$(openssl rand -base64 32)"
      else
        value="$(openssl rand -hex 32)"
      fi
      line="${key}=${value}${rest}"
      count=$((count + 1))
    fi
  fi
  printf '%s\n' "$line" >> "$TMP"
done < .env.example

if grep -Eq '^[A-Z0-9_]+=[^#[:space:]]*thali-demo-' "$TMP"; then
  echo "gen-env: a demo placeholder survived (bug); not writing $OUT" >&2
  exit 1
fi
mv "$TMP" "$OUT"
trap - EXIT
chmod 600 "$OUT"
echo "gen-env: wrote $OUT with $count fresh secrets (mode 600)."
echo "         Next: set APP_MODE and real providers, DEMO_OTP_ENABLED=false, DEMO_PHONES= (see .env.example)."
echo "         Existing stack data is encrypted with the old FIELD_ENCRYPTION_KEY: start from empty volumes."

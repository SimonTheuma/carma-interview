#!/bin/sh
set -eu
BASE="${BASE_URL:-http://127.0.0.1:3000}"

echo "readyz"
curl -fsS "$BASE/api/readyz" >/dev/null

echo "csp nonce on /"
csp_headers=$(curl -sI "$BASE/" | tr -d '\r' | grep -i '^content-security-policy:' || true)
csp_count=$(printf '%s\n' "$csp_headers" | grep -c . || true)
test "$csp_count" -eq 1
printf '%s\n' "$csp_headers" | grep -q 'nonce-'
# script-src must not allow unsafe-inline (style-src-attr may still list it)
script_src=$(printf '%s\n' "$csp_headers" | sed -n "s/.*script-src \([^;]*\).*/\1/p")
printf '%s\n' "$script_src" | grep -qv "unsafe-inline"

echo "no csp on api"
api_csp=$(curl -sI "$BASE/api/readyz" | tr -d '\r' | grep -i '^content-security-policy:' || true)
test -z "$api_csp"

echo "golden G1"
curl -fsS --get "$BASE/api/search" --data-urlencode 'q="oil prices" AND (geopolitical OR "supply chain")' | grep -q '"external_id":"1"'

echo "golden G2"
curl -fsS --get "$BASE/api/search" --data-urlencode 'q=renewable AND NOT (nuclear OR coal)' | grep -q '"external_id":"5"'

echo "arabic"
curl -fsS --get "$BASE/api/search" --data-urlencode 'q=عقارات' >/dev/null

echo "chinese"
curl -fsS --get "$BASE/api/search" --data-urlencode 'q=科技' >/dev/null

echo "aggregate"
curl -fsS --get "$BASE/api/aggregate" --data-urlencode 'q=' --data-urlencode 'bucket=week' >/dev/null

echo "status"
curl -fsS "$BASE/api/status" >/dev/null

echo "smoke ok"

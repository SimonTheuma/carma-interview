#!/bin/sh
set -eu

ROOT=/secrets
MASTER="$ROOT/.master"

# UIDs must match the consumer images (node:bookworm-slim, postgres, grafana).
UID_NODE=1000
UID_POSTGRES=999
UID_GRAFANA=472

rand() {
  tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40
}

mkdir -p "$MASTER" \
  "$ROOT/db" \
  "$ROOT/migrate" \
  "$ROOT/seed" \
  "$ROOT/web" \
  "$ROOT/worker" \
  "$ROOT/grafana"

ensure() {
  name="$1"
  if [ ! -f "$MASTER/$name" ]; then
    rand >"$MASTER/$name"
    echo "generated $name"
  else
    echo "kept $name"
  fi
}

ensure postgres_password
ensure app_ingest_password
ensure app_worker_password
ensure app_read_password
ensure cursor_secret
ensure grafana_admin_password

cp "$MASTER/postgres_password" "$ROOT/db/postgres_password"
cp "$MASTER/postgres_password" "$ROOT/migrate/postgres_password"
cp "$MASTER/app_ingest_password" "$ROOT/migrate/app_ingest_password"
cp "$MASTER/app_worker_password" "$ROOT/migrate/app_worker_password"
cp "$MASTER/app_read_password" "$ROOT/migrate/app_read_password"
cp "$MASTER/app_ingest_password" "$ROOT/seed/app_ingest_password"
cp "$MASTER/app_read_password" "$ROOT/web/app_read_password"
cp "$MASTER/cursor_secret" "$ROOT/web/cursor_secret"
cp "$MASTER/app_ingest_password" "$ROOT/web/app_ingest_password"
cp "$MASTER/app_worker_password" "$ROOT/worker/app_worker_password"
cp "$MASTER/grafana_admin_password" "$ROOT/grafana/grafana_admin_password"

# Owner-only secret files, owned by the UID that reads them in each container.
# (World-readable a+rX was too open; plain 600 as root broke USER node.)
secure_tree() {
  dir="$1"
  uid="$2"
  chmod 755 "$dir"
  find "$dir" -type f -exec chmod 600 {} \;
  chown -R "$uid:$uid" "$dir"
}

secure_tree "$ROOT/db" "$UID_POSTGRES"
secure_tree "$ROOT/migrate" "$UID_NODE"
secure_tree "$ROOT/seed" "$UID_NODE"
secure_tree "$ROOT/web" "$UID_NODE"
secure_tree "$ROOT/worker" "$UID_NODE"
secure_tree "$ROOT/grafana" "$UID_GRAFANA"

echo "secrets-init done"

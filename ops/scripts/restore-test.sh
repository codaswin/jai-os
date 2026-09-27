#!/usr/bin/env bash
# Restores the latest snapshot into a throwaway Postgres container and checks
# both Twenty's and the agent database's dumps. Touches nothing in the live
# stack. Run monthly and before major upgrades.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

work="$(mktemp -d)"
container="jai-os-restore-test"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

restic -v "$work:/restore" -- restore latest --target /restore
restic -v "$work:/restore" --entrypoint /bin/sh -- -c "chown -R $(id -u):$(id -g) /restore"

twenty_dump=$(ls "$work"/data/dumps/twenty-*.dump 2>/dev/null) ||
  { echo "twenty dump missing from snapshot" >&2; exit 1; }
agent_dump=$(ls "$work"/data/dumps/agent-*.dump 2>/dev/null) ||
  { echo "agent dump missing from snapshot (a snapshot from before ticket #24 has none — run backup.sh again first)" >&2; exit 1; }
[ -d "$work/data/storage" ] || { echo "storage missing from snapshot" >&2; exit 1; }
[ -f "$work/data/ops/docker-compose.yml" ] || { echo "deploy config missing from snapshot" >&2; exit 1; }

docker run -d --name "$container" -e POSTGRES_PASSWORD=restore-test postgres:16.15 >/dev/null
until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

restore_and_check() {
  local label="$1" dbname="$2" dump="$3"
  docker exec "$container" createdb -U postgres "$dbname"
  docker exec -i "$container" pg_restore -U postgres -d "$dbname" --no-owner < "$dump"

  local tables
  tables=$(docker exec "$container" psql -U postgres -d "$dbname" -tAc \
    "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")
  [ "$tables" -gt 0 ] || { echo "$label: restored database is empty" >&2; exit 1; }
  echo "$label ok: $tables tables restored from $(basename "$dump")"
}

# One consistent recovery point means both restore successfully from the same
# snapshot, not just Twenty's — a snapshot with a healthy Twenty dump and a
# broken or missing agent dump is exactly the failure mode this test exists
# to catch (ticket #24).
restore_and_check twenty restored "$twenty_dump"
restore_and_check agent restored_agent "$agent_dump"

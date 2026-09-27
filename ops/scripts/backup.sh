#!/usr/bin/env bash
# Dumps Twenty's Postgres and the agent database (ticket #20), then snapshots
# both dumps, file storage and deploy config into a single encrypted restic
# repo. One snapshot covers both databases at the same moment, so a restore
# lands on one consistent recovery point, not two independently-timed ones.
# Keeps 7 daily + 4 weekly snapshots.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# Same reasoning as healthcheck.sh's lock: an overlapping invocation (a stuck
# prior run, or a manual run colliding with cron) racing this one's
# rm-then-dump-then-restic sequence could delete a dump the other run hasn't
# finished writing yet, producing a torn pair that restic then backs up.
exec 9>"$LOG_DIR/backup.lock"
flock -n 9 || { alert "backup skipped: already running"; exit 0; }

# Not debounced like healthcheck.sh's alert_once: this runs once daily via
# cron, not polled every 5 minutes, so there's no repeat-spam risk to guard
# against — every failure here is a distinct, single event worth reporting.
trap 'alert "backup FAILED"; telegram_send "ALERT: backup FAILED"' ERR

[ -s "$RESTIC_PASSWORD_FILE" ] || { echo "missing $RESTIC_PASSWORD_FILE" >&2; exit 1; }

used_percent=$(df --output=pcent "$BACKUP_DIR" | tail -1 | tr -dc 0-9)
if [ "$used_percent" -ge 85 ]; then
  alert "backup disk ${used_percent}% full"
  telegram_send "ALERT: backup disk ${used_percent}% full"
fi

[ -e "$BACKUP_DIR/restic-repo/config" ] || restic -- init

mkdir -p "$BACKUP_DIR/dumps"
rm -f "$BACKUP_DIR"/dumps/*.dump
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
"${COMPOSE[@]}" exec -T db pg_dump -U "$PG_DATABASE_USER" -Fc "$PG_DATABASE_NAME" \
  > "$BACKUP_DIR/dumps/twenty-$timestamp.dump"
# Same db container, the agent's own role/database (ticket #20) — a separate
# dump, not a second database in the same one, since AGENT_DB_USER has (and
# should only ever have) grants on its own database, not Twenty's.
"${COMPOSE[@]}" exec -T db pg_dump -U "$AGENT_DB_USER" -Fc "$AGENT_DB_NAME" \
  > "$BACKUP_DIR/dumps/agent-$timestamp.dump"

restic \
  -v "$BACKUP_DIR/dumps:/data/dumps:ro" \
  -v jai-os_server-local-data:/data/storage:ro \
  -v "$OPS_DIR:/data/ops:ro" \
  -- backup /data/dumps /data/storage /data/ops \
  --exclude /data/ops/backups --exclude /data/ops/secrets --exclude /data/ops/logs

restic -- forget --keep-daily 7 --keep-weekly 4 --prune

date -u +%FT%TZ > "$BACKUP_DIR/last-success"
echo "backup ok"

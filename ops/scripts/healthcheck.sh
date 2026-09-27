#!/usr/bin/env bash
# Cron this every 5 minutes. Every problem is logged locally every run
# (logs/alerts.log, as in Phase 1); alert_once/recover_once (lib.sh) also
# push one Telegram message when a check starts failing and one when it
# recovers, not a message every 5 minutes for as long as it stays broken.
source "$(dirname "$0")/lib.sh"
problems=0

disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
if [ "$disk" -lt 85 ]; then
  recover_once disk "disk usage back to ${disk}%"
else
  alert_once disk "disk ${disk}% full"
  problems=1
fi

mem_free=$(awk '/MemAvailable/ {a=$2} /MemTotal/ {t=$2} END {print int(a*100/t)}' /proc/meminfo)
if [ "$mem_free" -gt 10 ]; then
  recover_once memory "memory available back to ${mem_free}%"
else
  alert_once memory "only ${mem_free}% memory available"
  problems=1
fi

for service in caddy server worker db redis; do
  state=$("${COMPOSE[@]}" ps --format '{{.Health}}{{.State}}' "$service" 2>/dev/null | head -1)
  case "$state" in
    healthy*|running) recover_once "service-$service" "service $service is healthy" ;;
    *)
      alert_once "service-$service" "service $service is not healthy (state: ${state:-missing})"
      problems=1
      ;;
  esac
done

last_success="$BACKUP_DIR/last-success"
if [ ! -f "$last_success" ] || [ -n "$(find "$last_success" -mmin +2160)" ]; then
  alert_once backup "no successful backup in the last 36h"
  problems=1
else
  recover_once backup "a successful backup exists within the last 36h"
fi

exit "$problems"

#!/usr/bin/env bash
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$OPS_DIR/backups}"
LOG_DIR="$OPS_DIR/logs"
STATE_FILE="$LOG_DIR/alert-state"
RESTIC_IMAGE="restic/restic:0.19.1"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$OPS_DIR/secrets/restic-password}"
COMPOSE=(docker compose --project-directory "$OPS_DIR" -f "$OPS_DIR/docker-compose.yml")

mkdir -p "$LOG_DIR" "$BACKUP_DIR"
touch "$STATE_FILE"

# Loaded here, not just by backup.sh, so TELEGRAM_BOT_TOKEN/
# TELEGRAM_FOUNDER_CHAT_ID below are available without every caller needing
# its own `source .env` line. Guarded: a deploy that predates ticket #16 (no
# .env yet, or no Telegram keys in it) must keep working exactly as before.
[ -f "$OPS_DIR/.env" ] && { set -a; source "$OPS_DIR/.env"; set +a; }

alert() {
  echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG_DIR/alerts.log" >&2
}

# Best-effort, never the reason ops tooling fails: does nothing until both
# Telegram vars exist (added by hand per ops/README.md, ticket #16), and a
# delivery failure (network, revoked token) is swallowed rather than
# propagated.
telegram_send() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_FOUNDER_CHAT_ID:-}" ] || return 0
  curl -fsS -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_FOUNDER_CHAT_ID}" --data-urlencode "text=$1" \
    >/dev/null 2>&1 || true
}

was_active() { grep -qxF "$1" "$STATE_FILE" 2>/dev/null; }

# Logs locally every run, as alert() always has; pushes to Telegram only the
# first time this named condition starts failing, not every run it stays
# broken (cron runs this every 5 minutes — without this, a persistent
# problem would send a message every 5 minutes forever).
alert_once() {
  local name="$1" message="$2"
  alert "$message"
  if ! was_active "$name"; then
    echo "$name" >> "$STATE_FILE"
    telegram_send "ALERT: $message"
  fi
}

# The other half of alert_once — call every run a check passes. A no-op
# unless that name was previously alert_once'd and hasn't recovered yet, so
# calling it on every healthy run doesn't spam a recovery notice nobody needs.
recover_once() {
  local name="$1" message="$2"
  if was_active "$name"; then
    # Not `grep -v ... && mv`: grep exits 1 (no lines *selected*) when the
    # removed name was the only line, which would short-circuit the mv and
    # leave the stale entry in place — silently breaking the debounce this
    # function exists for on exactly the common one-active-problem case.
    grep -vxF "$name" "$STATE_FILE" >"$STATE_FILE.tmp" 2>/dev/null
    mv "$STATE_FILE.tmp" "$STATE_FILE"
    alert "RECOVERED: $message"
    telegram_send "RECOVERED: $message"
  fi
}

# Extra docker args (extra mounts) go before "--", restic args after.
restic() {
  local docker_args=()
  while [ "$1" != "--" ]; do docker_args+=("$1"); shift; done
  shift
  docker run --rm -h jai-os \
    -v "$BACKUP_DIR/restic-repo:/repo" \
    -v "$RESTIC_PASSWORD_FILE:/password:ro" \
    -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD_FILE=/password \
    "${docker_args[@]}" "$RESTIC_IMAGE" "$@"
}

#!/usr/bin/env bash
# tether -- Start the Next.js dev server in the background.
# Idempotent: kills any stale instance first, waits until the new one is ready.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PID_FILE=".dev-server.pid"
LOG_FILE=".dev-server.log"
PORT="${PORT:-3000}"
READY_TIMEOUT="${READY_TIMEOUT:-180}"

kill_pid() {
  local pid="$1"
  if [ -z "$pid" ]; then return 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
}

# 1. Stop whatever is recorded in the PID file.
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  kill_pid "$OLD_PID"
  rm -f "$PID_FILE"
fi

# 2. Fallback: clear anything still bound to the port (PID file drift,
#    orphaned child processes from prior crashes, Next.js child workers, etc).
#    WSL2's lsof can miss listeners that fuser sees, so run both when available.
port_in_use() {
  if command -v fuser >/dev/null 2>&1 && fuser -s "${PORT}/tcp" 2>/dev/null; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -ti:"$PORT" 2>/dev/null || true)" ]; then
    return 0
  fi
  return 1
}

clear_port() {
  local sig="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti:"$PORT" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill "$sig" $pids 2>/dev/null || true
    fi
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "$sig" "${PORT}/tcp" 2>/dev/null || true
  fi
}

if port_in_use; then
  echo "Clearing stray process(es) on port $PORT"
  clear_port -TERM
  sleep 1
  port_in_use && clear_port -KILL
  sleep 0.5
fi

# 3. Start fresh, detached.
: > "$LOG_FILE"
nohup npm run dev >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
disown "$NEW_PID" 2>/dev/null || true
echo "$NEW_PID" > "$PID_FILE"
echo "Started dev server (pid $NEW_PID), logging to $LOG_FILE"

# 4. Wait until Next.js logs its readiness line, then confirm the port answers.
#    Next 16 + Turbopack compiles routes lazily on first request, so a curl-only
#    probe can hang well past server-ready while the initial route compiles.
DEADLINE=$(( $(date +%s) + READY_TIMEOUT ))
ready_logged=0
while :; do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "ERROR: dev server process exited before becoming ready." >&2
    echo "---- last 40 log lines ----" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  if [ "$ready_logged" -eq 0 ] && grep -qE '(Ready in|started server on|Local:[[:space:]]+http)' "$LOG_FILE" 2>/dev/null; then
    ready_logged=1
    echo "Dev server ready on http://localhost:${PORT}/ (per log)"
    exit 0
  fi
  if curl -fsS --connect-timeout 3 --max-time 5 -o /dev/null "http://localhost:${PORT}/" 2>/dev/null \
    || curl -sS --connect-timeout 3 --max-time 5 -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/" 2>/dev/null | grep -qE '^[23][0-9][0-9]$'; then
    echo "Dev server ready on http://localhost:${PORT}/"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "ERROR: dev server did not become ready within ${READY_TIMEOUT}s." >&2
    echo "---- last 40 log lines ----" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 0.5
done

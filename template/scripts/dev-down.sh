#!/usr/bin/env bash
# tether -- Stop the Next.js dev server.
# Idempotent: safe to run when nothing is up.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PID_FILE=".dev-server.pid"
PORT="${PORT:-3000}"

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

# 1. Kill the PID we recorded, if any.
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ]; then
    kill_pid "$PID"
    echo "Stopped dev server (pid $PID)"
  fi
  rm -f "$PID_FILE"
fi

# 2. Fallback: clear anything still bound to the port.
#    Catches Next.js child workers that aren't the parent PID.
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
fi

exit 0

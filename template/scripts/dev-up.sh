#!/usr/bin/env bash
# Start the dev server in the background.
# Idempotent: stops this project's stale server first, then waits until ready.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PID_FILE=".dev-server.pid"
LOG_FILE=".dev-server.log"
REGISTRY_DIR="${RALPH_HOME:-$HOME/.ralph}"
REGISTRY_FILE="$REGISTRY_DIR/servers.json"
READY_TIMEOUT="${READY_TIMEOUT:-180}"

load_env_file() {
  local file="$1"
  if [ ! -f "$file" ]; then return 0; fi
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

load_env_file ".env"
load_env_file ".env.local"

DEV_PORT="${DEV_PORT:-${PORT:-{{devPort}}}}"
PORT="$DEV_PORT"
DEV_COMMAND="${DEV_COMMAND:-npm run dev}"

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

registry_update() {
  local action="$1"
  local pid="${2:-}"
  mkdir -p "$REGISTRY_DIR"
  node - "$REGISTRY_FILE" "$action" "$ROOT_DIR" "$PORT" "$pid" <<'NODE'
const fs = require("fs");
const [registryFile, action, project, port, pid] = process.argv.slice(2);
let registry = [];
try {
  registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  if (!Array.isArray(registry)) registry = [];
} catch {
  registry = [];
}
registry = registry.filter((entry) => entry && entry.project !== project);
registry = registry.filter((entry) => {
  if (!entry.pid) return false;
  try {
    process.kill(Number(entry.pid), 0);
    return true;
  } catch {
    return false;
  }
});
if (action === "register") {
  registry.push({
    project,
    port: Number(port),
    pid: Number(pid),
    started: new Date().toISOString(),
  });
}
fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + "\n");
NODE
}

registry_pid_for_port() {
  node - "$REGISTRY_FILE" "$ROOT_DIR" "$PORT" <<'NODE'
const fs = require("fs");
const [registryFile, project, port] = process.argv.slice(2);
let registry = [];
try {
  registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
} catch {}
const entry = Array.isArray(registry)
  ? registry.find((item) => String(item.port) === String(port) && item.project !== project)
  : undefined;
if (entry && entry.pid) process.stdout.write(String(entry.pid));
NODE
}

port_in_use() {
  if command -v fuser >/dev/null 2>&1 && fuser -s "${PORT}/tcp" 2>/dev/null; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -ti:"$PORT" 2>/dev/null || true)" ]; then
    return 0
  fi
  return 1
}

clear_own_port_processes() {
  local registry_pid
  registry_pid="$(registry_pid_for_port || true)"
  if [ -n "$registry_pid" ] && kill -0 "$registry_pid" 2>/dev/null; then
    echo "ERROR: port $PORT is registered to another Ralph project (pid $registry_pid)." >&2
    echo "Run that project's ./scripts/dev-down.sh or choose another DEV_PORT in .env.local." >&2
    exit 1
  fi
}

# Stop this project's previous server, if any.
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  kill_pid "$OLD_PID"
  rm -f "$PID_FILE"
fi
registry_update unregister

if port_in_use; then
  clear_own_port_processes
  echo "ERROR: port $PORT is already in use by an unregistered process." >&2
  echo "Stop that process or set DEV_PORT to another value in .env.local." >&2
  exit 1
fi

: > "$LOG_FILE"
PORT="$PORT" DEV_PORT="$DEV_PORT" bash -lc "$DEV_COMMAND" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
disown "$NEW_PID" 2>/dev/null || true
echo "$NEW_PID" > "$PID_FILE"
registry_update register "$NEW_PID"
echo "Started dev server (pid $NEW_PID) on port $PORT, logging to $LOG_FILE"

DEADLINE=$(( $(date +%s) + READY_TIMEOUT ))
while :; do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "ERROR: dev server process exited before becoming ready." >&2
    echo "---- last 40 log lines ----" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    registry_update unregister
    exit 1
  fi
  if grep -qE '(Ready in|started server on|Local:[[:space:]]+http|localhost:|http://)' "$LOG_FILE" 2>/dev/null; then
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

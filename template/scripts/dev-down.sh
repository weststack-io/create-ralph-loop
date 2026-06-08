#!/usr/bin/env bash
# Stop this project's dev server.
# Idempotent: safe to run when nothing is up.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PID_FILE=".dev-server.pid"
REGISTRY_DIR="${RALPH_HOME:-$HOME/.ralph}"
REGISTRY_FILE="$REGISTRY_DIR/servers.json"

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
  mkdir -p "$REGISTRY_DIR"
  node - "$REGISTRY_FILE" "$ROOT_DIR" <<'NODE'
const fs = require("fs");
const [registryFile, project] = process.argv.slice(2);
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
fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + "\n");
NODE
}

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ]; then
    kill_pid "$PID"
    echo "Stopped dev server (pid $PID)"
  fi
  rm -f "$PID_FILE"
fi

registry_update
exit 0

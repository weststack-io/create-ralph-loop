#!/usr/bin/env bash
# Clean stale Ralph dev-server registry entries and optionally stop live servers.

set -euo pipefail

REGISTRY_DIR="${RALPH_HOME:-$HOME/.ralph}"
REGISTRY_FILE="$REGISTRY_DIR/servers.json"
KILL_LIVE="${1:-}"

mkdir -p "$REGISTRY_DIR"

node - "$REGISTRY_FILE" "$KILL_LIVE" <<'NODE'
const fs = require("fs");
const [registryFile, killLive] = process.argv.slice(2);
let registry = [];
try {
  registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  if (!Array.isArray(registry)) registry = [];
} catch {
  registry = [];
}

const survivors = [];
for (const entry of registry) {
  if (!entry || !entry.pid) continue;
  const pid = Number(entry.pid);
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {}

  if (alive && killLive === "--kill-live") {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`Stopped ${entry.project} on port ${entry.port} (pid ${pid})`);
    } catch {}
    continue;
  }

  if (alive) {
    survivors.push(entry);
  } else {
    console.log(`Removed stale registry entry for ${entry.project} on port ${entry.port}`);
  }
}

fs.writeFileSync(registryFile, JSON.stringify(survivors, null, 2) + "\n");
NODE

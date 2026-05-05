#!/bin/bash

# Usage: ralph.sh [--claude|--codex] <iterations>
# Default runner: claude

RUNNER="claude"
if [[ "$1" == "--codex" ]]; then
  RUNNER="codex"
  shift
elif [[ "$1" == "--claude" ]]; then
  RUNNER="claude"
  shift
fi

if [ -z "$1" ]; then
  echo "Usage: $0 [--claude|--codex] <iterations>"
  exit 1
fi

PROMPT="$(cat ./specs/phase1/prompts/coding_prompt.md)"

# --- Server lifecycle: start once, clean up on exit ---
echo "=== Initializing environment and starting dev server ==="
./scripts/dev-down.sh
./init.sh
./scripts/dev-up.sh || { echo "FATAL: dev server failed to start"; exit 1; }

trap './scripts/dev-down.sh' EXIT

echo "=== Running $1 iteration(s) with $RUNNER ==="

for ((i=1; i<=$1; i++)); do
  echo "Iteration $i"
  echo "--------------------------------"

  if [ "$RUNNER" = "claude" ]; then
    result=$(claude -p "$PROMPT" --allowedTools "Read,Write,Edit,Glob,Grep,Bash,mcp__playwright" --output-format text 2>&1) || true
  else
    result=$(codex exec --yolo -o /dev/stdout "$PROMPT" 2>&1) || true
  fi

  echo "$result"

  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    echo "All tasks complete after $i iterations."
    exit 0
  fi

  echo ""
  echo "--- End of iteration $i ---"
  echo ""
done

echo "Reached max iterations ($1)"
exit 1

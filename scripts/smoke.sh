#!/usr/bin/env bash
# ndomo smoke tests wrapper — runs src/cli/smoke.ts via bun
# Exit 0 if all smoke checks pass, exit 1 on any failure.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[smoke] running ndomo smoke tests via bun..."
bun run src/cli/smoke.ts

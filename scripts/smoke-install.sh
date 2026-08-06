#!/usr/bin/env bash
# ndomo installer smoke test — verifies TS installer works end-to-end in a
# fresh tmp directory. Idempotent: cleans up tmp on exit (success or failure).
# Exit 0 if all smoke checks pass, exit 1 on any failure.
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
readonly GREEN='\033[0;32m'
readonly RED='\033[0;31m'
readonly YELLOW='\033[0;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKTREE_ROOT="$PROJECT_ROOT"

# ── Isolated tmp dir + cleanup trap ───────────────────────────────────────────
TMPDIR="$(mktemp -d -t ndomo-smoke-install-XXXXXX)"
export XDG_CONFIG_HOME="$TMPDIR/config"

cleanup() {
  local exit_code=$?
  rm -rf "$TMPDIR"
  if [[ $exit_code -eq 0 ]]; then
    echo -e "${GREEN}[smoke-install]${NC} tmp cleaned: $TMPDIR"
  else
    echo -e "${RED}[smoke-install]${NC} tmp cleaned (after failure): $TMPDIR"
  fi
  exit $exit_code
}
trap cleanup EXIT

echo -e "${BLUE}[smoke-install]${NC} tmp dir: $TMPDIR"
echo -e "${BLUE}[smoke-install]${NC} XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
echo -e "${YELLOW}[smoke-install]${NC} running: bun run src/cli/install.ts --dry-run --preset=default --enable-http"

# ── Run installer (dry-run, safe — does not write to filesystem) ──────────────
cd "$PROJECT_ROOT"
if bun run src/cli/install.ts --dry-run --preset=default --enable-http; then
  echo -e "${GREEN}[smoke-install] PASS:${NC} bunx ndomo install dry-run completed"
  exit 0
else
  echo -e "${RED}[smoke-install] FAIL:${NC} install.ts dry-run exited non-zero" >&2
  exit 1
fi
#!/usr/bin/env bash
# render-diagrams.sh — render docs/diagrams/*.d2 → sibling .svg on demand
#
# Renders every versioned .d2 source under docs/diagrams/ to a sibling .svg
# using the d2 CLI (https://d2lang.com). Rendered SVGs are gitignored — they
# are build artifacts, regenerate them any time.
#
# Usage:
#   ./scripts/render-diagrams.sh           # render all docs/diagrams/*.d2
#   bun run diagrams:render                # via package.json
#
# Exit codes:
#   0  all rendered (or nothing to render)
#   1  d2 missing / render failure
#
# Idempotent: safe to run multiple times, overwrites existing SVGs.

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { printf "${BLUE}[render-diagrams]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[render-diagrams]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[render-diagrams]${NC} %s\n" "$*"; }
err()   { printf "${RED}[render-diagrams]${NC} %s\n" "$*" >&2; }

# ── Detect project root ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
if git -C "$PROJECT_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  PROJECT_ROOT="$(git -C "$PROJECT_ROOT" rev-parse --show-toplevel)"
fi
DIAGRAM_DIR="$PROJECT_ROOT/docs/diagrams"

# ── d2 availability ───────────────────────────────────────────────────────────
if ! command -v d2 >/dev/null 2>&1; then
  err "d2 is not installed (or not on PATH)."
  err "Install it from https://d2lang.com — quick start:"
  err "  curl -fsSL https://d2lang.com/install.sh | sh -s --"
  err "  # or: brew install d2 (macOS), go install oss.terrastruct.com/d2@latest"
  exit 1
fi

# ── Nothing to render? ────────────────────────────────────────────────────────
if [[ ! -d "$DIAGRAM_DIR" ]]; then
  warn "no diagram dir at $DIAGRAM_DIR — nothing to render"
  exit 0
fi

shopt -s nullglob
sources=("$DIAGRAM_DIR"/*.d2)
shopt -u nullglob

if [[ ${#sources[@]} -eq 0 ]]; then
  warn "no .d2 sources in $DIAGRAM_DIR — nothing to render"
  exit 0
fi

# ── Render ────────────────────────────────────────────────────────────────────
info "rendering ${#sources[@]} diagram(s) from $DIAGRAM_DIR"
rendered=0
for src in "${sources[@]}"; do
  out="${src%.d2}.svg"
  if d2 "$src" "$out"; then
    rendered=$((rendered + 1))
    info "  $(basename "$src") → $(basename "$out")"
  else
    err "d2 failed on $src"
    exit 1
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
ok "rendered $rendered/${#sources[@]} diagram(s) → $DIAGRAM_DIR/*.svg"

#!/usr/bin/env bash
# dev-bust-cache.sh — bust Bun transpiler cache for ndomo dev loop
#
# Root cause: Bun caches TS modules in ~/.bun/install/cache/ keyed by resolved
# path. When ndomo is loaded via symlink, the cache key uses the symlink path,
# so editing source files doesn't invalidate the cache → stale code served.
#
# This script:
#   1. Optionally kills running opencode processes (--kill)
#   2. Removes Bun cache entries referencing ndomo or src/index.ts
#   3. Touches all src/*.ts to bump mtime (forces re-transpilation)
#
# Usage:
#   ./scripts/dev-bust-cache.sh                  # dry-run (show what would be done)
#   ./scripts/dev-bust-cache.sh --apply          # actually execute
#   ./scripts/dev-bust-cache.sh --apply --kill   # kill opencode + bust cache
#   bun run dev:bust                             # via package.json (dry-run)
#   bun run dev:reset                            # kill opencode + bust (apply)
#
# Idempotent: safe to run multiple times. No-op if cache is already clean.

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { printf "${BLUE}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
err()   { printf "${RED}[error]${NC} %s\n" "$*" >&2; }

# ── Parse flags ───────────────────────────────────────────────────────────────
APPLY=false
KILL=false

for arg in "$@"; do
  case "$arg" in
    --apply|--force|-f) APPLY=true ;;
    --kill)             KILL=true ;;
    --help|-h)
      cat <<EOF
${BOLD}dev-bust-cache.sh — bust Bun cache for ndomo dev loop${NC}

Usage:
  ./scripts/dev-bust-cache.sh [OPTIONS]

Options:
  --apply    Actually execute (default: dry-run, show what would be done)
  --kill     Kill running opencode processes before busting
  --help     Show this help

Without --apply, shows what would be done (dry-run).
EOF
      exit 0
      ;;
    *) err "Unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

# ── Detect project root ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_ROOT/src"

# ── Bun cache dir ─────────────────────────────────────────────────────────────
BUN_CACHE="${HOME}/.bun/install/cache"

if [[ ! -d "$BUN_CACHE" ]]; then
  warn "Bun cache not found at $BUN_CACHE — nothing to bust"
  exit 0
fi

# ── Step 1: Kill opencode processes (if --kill) ──────────────────────────────
if [[ "$KILL" == true ]]; then
  info "Looking for opencode processes..."
  PIDS=$(pgrep -f "opencode" 2>/dev/null || true)
  if [[ -n "$PIDS" ]]; then
    if [[ "$APPLY" == false ]]; then
      info "[dry-run] would kill opencode PIDs: ${PIDS//$'\n'/, }"
    else
      for pid in $PIDS; do
        kill "$pid" 2>/dev/null || true
      done
      sleep 1
      ok "Killed opencode processes"
    fi
  else
    info "No opencode processes found"
  fi
fi

# ── Step 2: Remove Bun cache entries referencing ndomo ───────────────────────
info "Searching Bun cache for ndomo references..."
NDOMO_CACHE_FILES=$(grep -rl "ndomo" "$BUN_CACHE" 2>/dev/null || true)

if [[ -n "$NDOMO_CACHE_FILES" ]]; then
  COUNT=$(echo "$NDOMO_CACHE_FILES" | wc -l)
  if [[ "$APPLY" == false ]]; then
    info "[dry-run] would remove $COUNT cache file(s) referencing ndomo:"
    echo "$NDOMO_CACHE_FILES" | sed 's/^/  /'
  else
    echo "$NDOMO_CACHE_FILES" | while IFS= read -r f; do
      rm -f "$f"
    done
    ok "Removed $COUNT cache file(s) referencing ndomo"
  fi
else
  info "No cache files reference ndomo"
fi

# ── Step 3: Remove Bun cache entries referencing ndomo source path ───────────
# Narrow grep to $PROJECT_ROOT/src to avoid matching unrelated packages
# that happen to have index.ts in their dist files.
info "Searching Bun cache for ndomo source path references..."
INDEX_CACHE_FILES=$(grep -rl "$PROJECT_ROOT/src" "$BUN_CACHE" 2>/dev/null || true)

if [[ -n "$INDEX_CACHE_FILES" ]]; then
  COUNT=$(echo "$INDEX_CACHE_FILES" | wc -l)
  if [[ "$APPLY" == false ]]; then
    info "[dry-run] would remove $COUNT cache file(s) referencing $PROJECT_ROOT/src:"
    echo "$INDEX_CACHE_FILES" | sed 's/^/  /'
  else
    echo "$INDEX_CACHE_FILES" | while IFS= read -r f; do
      rm -f "$f"
    done
    ok "Removed $COUNT cache file(s) referencing ndomo source path"
  fi
else
  info "No cache files reference ndomo source path"
fi

# ── Step 4: Touch all src/*.ts to bump mtime ─────────────────────────────────
if [[ -d "$SRC_DIR" ]]; then
  info "Touching src/*.ts files to bump mtime..."
  TS_FILES=$(find "$SRC_DIR" -name "*.ts" -type f 2>/dev/null || true)
  if [[ -n "$TS_FILES" ]]; then
    COUNT=$(echo "$TS_FILES" | wc -l)
    if [[ "$APPLY" == false ]]; then
      info "[dry-run] would touch $COUNT .ts file(s) in $SRC_DIR"
    else
      echo "$TS_FILES" | while IFS= read -r f; do
        touch "$f"
      done
      ok "Touched $COUNT .ts file(s)"
    fi
  else
    info "No .ts files found in $SRC_DIR"
  fi
else
  warn "src/ directory not found at $SRC_DIR"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ "$APPLY" == false ]]; then
  warn "DRY RUN — no changes made. Run with --apply to execute."
else
  ok "Cache busted. Restart opencode to pick up changes."
fi

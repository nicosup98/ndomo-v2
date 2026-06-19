#!/usr/bin/env bash
# ndomo uninstaller — removes agents, skills, and config from ~/.config/opencode/
# Usage: ./uninstall.sh [--keep-data]

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { printf "${BLUE}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
err()   { printf "${RED}[error]${NC} %s\n" "$*" >&2; }

# ── Parse flags ───────────────────────────────────────────────────────────────
KEEP_DATA=false

for arg in "$@"; do
  case "$arg" in
    --keep-data)  KEEP_DATA=true ;;
    --help|-h)
      echo "Usage: ./uninstall.sh [--keep-data]"
      echo ""
      echo "Options:"
      echo "  --keep-data    Skip removal of .slim/ directory and opencode-mem data"
      exit 0
      ;;
    *)
      err "Unknown option: $arg (try --help)"
      exit 1
      ;;
  esac
done

# ── Paths ─────────────────────────────────────────────────────────────────────
CONFIG_DIR="${HOME}/.config/opencode"

# ── Agent files to remove ─────────────────────────────────────────────────────
AGENTS=(
  "foreman.md"
  "scout.md"
  "scribe.md"
  "painter.md"
  "smith.md"
  "sage.md"
  "guild.md"
  "go-smith.md"
  "js-smith.md"
  "python-smith.md"
  "vue-smith.md"
  "zig-smith.md"
  "rust-smith.md"
  "inspector.md"
  "chronicler.md"
)

# ── Skill directories to remove ───────────────────────────────────────────────
SKILLS=(
  "caveman"
  "cavecrew"
  "deepwork"
  "reflect"
  "worktrees"
  "dcp-integration"
  "mem-recall"
)

# ── Config files to remove ────────────────────────────────────────────────────
CONFIGS=(
  "ndomo.json"
  "ndomo.schema.json"
)

echo ""
printf "${YELLOW}${BOLD}ndomo uninstaller${NC}\n"
echo ""

# ── Step 1: Remove agent files ───────────────────────────────────────────────
info "Removing agent files..."
AGENT_DIR="${CONFIG_DIR}/agent"
AGENT_REMOVED=0
for name in "${AGENTS[@]}"; do
  target="${AGENT_DIR}/${name}"
  if [[ -f "$target" ]]; then
    rm -f "$target"
    ok "Removed agent/${name}"
    AGENT_REMOVED=$((AGENT_REMOVED + 1))
  fi
done
if [[ $AGENT_REMOVED -eq 0 ]]; then
  info "No ndomo agent files found"
else
  ok "Removed ${AGENT_REMOVED} agent file(s)"
fi

# ── Step 2: Remove skill directories ─────────────────────────────────────────
info "Removing skill directories..."
SKILL_DIR="${CONFIG_DIR}/skills"
SKILL_REMOVED=0
for name in "${SKILLS[@]}"; do
  target="${SKILL_DIR}/${name}"
  if [[ -d "$target" ]]; then
    rm -rf "$target"
    ok "Removed skills/${name}/"
    SKILL_REMOVED=$((SKILL_REMOVED + 1))
  fi
done
if [[ $SKILL_REMOVED -eq 0 ]]; then
  info "No ndomo skill directories found"
else
  ok "Removed ${SKILL_REMOVED} skill directory(ies)"
fi

# ── Step 3: Remove config files ──────────────────────────────────────────────
info "Removing config files..."
CONFIG_REMOVED=0
for name in "${CONFIGS[@]}"; do
  target="${CONFIG_DIR}/${name}"
  if [[ -f "$target" ]]; then
    rm -f "$target"
    ok "Removed ${name}"
    CONFIG_REMOVED=$((CONFIG_REMOVED + 1))
  fi
done
if [[ $CONFIG_REMOVED -eq 0 ]]; then
  info "No ndomo config files found"
else
  ok "Removed ${CONFIG_REMOVED} config file(s)"
fi

# ── Step 4: Data removal (.slim/, mem data) ──────────────────────────────────
SLIM_DIR="${HOME}/.slim"
MEM_DIR="${HOME}/.ndomo/mem"

if [[ "$KEEP_DATA" == true ]]; then
  info "Keeping data (--keep-data specified)"
else
  HAS_DATA=false
  [[ -d "$SLIM_DIR" ]] && HAS_DATA=true
  [[ -d "$MEM_DIR" ]] && HAS_DATA=true

  if [[ "$HAS_DATA" == true ]]; then
    echo ""
    printf "${YELLOW}${BOLD}Data directories found:${NC}\n"
    [[ -d "$SLIM_DIR" ]] && printf "  - ${SLIM_DIR}\n"
    [[ -d "$MEM_DIR" ]]  && printf "  - ${MEM_DIR}\n"
    echo ""
    printf "${YELLOW}These may contain session data and memories.${NC}\n"
    printf "${YELLOW}This action cannot be undone.${NC}\n"
    echo ""
    read -rp "Remove data directories? [y/N] " confirm
    case "$confirm" in
      [yY]|[yY][eE][sS])
        if [[ -d "$SLIM_DIR" ]]; then
          rm -rf "$SLIM_DIR"
          ok "Removed ${SLIM_DIR}"
        fi
        if [[ -d "$MEM_DIR" ]]; then
          rm -rf "$MEM_DIR"
          ok "Removed ${MEM_DIR}"
        fi
        ;;
      *)
        info "Skipping data removal"
        ;;
    esac
  else
    info "No data directories found to clean"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
printf "${GREEN}${BOLD}════════════════════════════════════════${NC}\n"
printf "${GREEN}${BOLD}  ndomo uninstalled${NC}\n"
printf "${GREEN}${BOLD}════════════════════════════════════════${NC}\n"
echo ""
printf "${BOLD}Removed:${NC}\n"
printf "  Agents:  %d file(s)\n" "$AGENT_REMOVED"
printf "  Skills:  %d directory(ies)\n" "$SKILL_REMOVED"
printf "  Config:  %d file(s)\n" "$CONFIG_REMOVED"
echo ""
printf "${BOLD}Note:${NC} This does NOT uninstall opencode-mem or @tarquinen/opencode-dcp.\n"
printf "  Those are separate plugins managed by opencode.\n"
echo ""

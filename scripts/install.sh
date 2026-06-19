#!/usr/bin/env bash
# ndomo installer — copies agents, skills, and config into ~/.config/opencode/
# Usage: ./install.sh [OPTIONS]
#        curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash

# ── Pipe detection (must be first, before set -e) ──────────────────────────────
# When invoked via pipe/stdin, clone repo to temp dir and re-exec from disk.
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "bash" || "${BASH_SOURCE[0]}" == "/dev/stdin" ]]; then
  PIPED=true

  REPO_URL="${NDOMO_REPO_URL:-https://github.com/darrenhinde/OpenAgentsControl}"
  REPO_BRANCH="${NDOMO_REPO_BRANCH:-main}"

  # Parse --repo= and --branch= from args early (for piped mode)
  for arg in "$@"; do
    case "$arg" in
      --repo=*)   REPO_URL="${arg#--repo=}" ;;
      --branch=*) REPO_BRANCH="${arg#--branch=}" ;;
    esac
  done

  TMPDIR=$(mktemp -d -t ndomo-install-XXXXXX)
  trap "rm -rf $TMPDIR" EXIT

  if command -v git &>/dev/null; then
    git clone --depth=1 --branch "$REPO_BRANCH" "$REPO_URL" "$TMPDIR/repo" 2>/dev/null
  elif command -v curl &>/dev/null; then
    curl -fsSL "${REPO_URL}/archive/refs/heads/${REPO_BRANCH}.tar.gz" | tar -xz -C "$TMPDIR"
    mv "$TMPDIR/OpenAgentsControl-${REPO_BRANCH}" "$TMPDIR/repo" 2>/dev/null || mv "$TMPDIR"/*-main "$TMPDIR/repo"
  else
    echo "[error] Need git or curl to install from URL" >&2
    exit 1
  fi

  exec bash "${TMPDIR}/repo/scripts/install.sh" "$@"
fi
PIPED=false

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
die()   { err "$*"; exit 1; }

# ── Provider selection ─────────────────────────────────────────────────────────
select_provider() {
  local catalog_url="https://models.dev/catalog.json"
  local cache="${HOME}/.cache/ndomo/models-catalog.json"
  local catalog=""

  # Try network first
  if command -v curl &>/dev/null; then
    catalog=$(curl -fsSL --max-time 10 "$catalog_url" 2>/dev/null) || catalog=""
  fi

  # Cache fallback
  if [[ -z "$catalog" && -f "$cache" ]]; then
    catalog=$(cat "$cache")
  fi

  # No catalog at all: skip with warning
  if [[ -z "$catalog" ]]; then
    warn "Could not fetch models.dev catalog (no network or curl missing)"
    warn "Skipping provider selection — agents will keep default models"
    return 1
  fi

  # Cache for next time
  mkdir -p "$(dirname "$cache")"
  echo "$catalog" > "$cache"

  # Parse and display
  local providers
  providers=$(echo "$catalog" | jq -r '.providers | to_entries | sort_by(.value.name) | .[] | "\(.key)\t\(.value.name)"') || true

  # Show top 20 with numbers
  echo ""
  printf "${BOLD}Select a model provider:${NC}\n"
  printf "${BOLD}  %-4s %-30s %s${NC}\n" "#" "ID" "Name"
  local i=1
  echo "$providers" | head -20 | while IFS=$'\t' read -r id name; do
    printf "  %-4s %-30s %s\n" "$i" "$id" "$name"
    i=$((i+1))
  done

  # Get user choice
  read -rp "$(printf "${BOLD}Provider [1-20, or type id]: ${NC}")" choice

  # Resolve
  local chosen_id
  if [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -ge 1 ]] && [[ "$choice" -le 20 ]]; then
    chosen_id=$(echo "$providers" | sed -n "${choice}p" | cut -f1)
  else
    chosen_id="$choice"
  fi

  if [[ -z "$chosen_id" ]]; then
    return 1
  fi

  PROVIDER="$chosen_id"
  ok "Provider set to: $PROVIDER"
}

usage() {
  cat <<EOF
${BOLD}ndomo installer${NC}

${BOLD}Usage:${NC}
  ./install.sh [OPTIONS]
  curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s [-- OPTIONS]

${BOLD}Options:${NC}
  --with-dcp            Also install @tarquinen/opencode-dcp (AGPL-3.0 peer)
  --preset=NAME         Use preset (default: "default", options: "default", "budget")
  --provider=ID         Set model provider for all agents (e.g., opencode, anthropic, openai)
  --no-provider-prompt  Skip interactive provider/model selection
  --repo=URL            Override repository URL (for piped installs)
  --branch=NAME         Override repository branch (for piped installs)
  --uninstall           Run uninstaller instead
  --help                Show this help

${BOLD}Examples:${NC}
  ./install.sh                          # default install
  ./install.sh --preset=budget          # budget models
  ./install.sh --provider=opencode --no-provider-prompt  # use opencode models
  ./install.sh --with-dcp               # include DCP plugin
  ./install.sh --uninstall              # remove ndomo
  curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash
EOF
}

# ── Parse flags ───────────────────────────────────────────────────────────────
WITH_DCP=false
PRESET="default"
RUN_UNINSTALL=false
PROVIDER=""
PROVIDER_PROMPT=true

for arg in "$@"; do
  case "$arg" in
    --with-dcp)          WITH_DCP=true ;;
    --preset=*)          PRESET="${arg#--preset=}" ;;
    --uninstall)         RUN_UNINSTALL=true ;;
    --provider=*)        PROVIDER="${arg#--provider=}" ;;
    --no-provider-prompt) PROVIDER_PROMPT=false ;;
    --repo=*)            NDOMO_REPO_URL="${arg#--repo=}" ;;
    --branch=*)          NDOMO_REPO_BRANCH="${arg#--branch=}" ;;
    --help|-h)           usage; exit 0 ;;
    *)                   die "Unknown option: $arg (try --help)" ;;
  esac
done

# ── Provider selection (interactive picker) ──────────────────────────────────
if [[ -z "$PROVIDER" && -t 0 && "${PIPED:-false}" != "true" && "$PROVIDER_PROMPT" == true ]]; then
  select_provider || true
fi

# ── Uninstall shortcut ────────────────────────────────────────────────────────
if [[ "$RUN_UNINSTALL" == true ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  exec bash "${SCRIPT_DIR}/uninstall.sh"
fi

# ── Validate preset ──────────────────────────────────────────────────────────
case "$PRESET" in
  default|budget) ;;
  *) die "Unknown preset: $PRESET (options: default, budget)" ;;
esac

# ── Detect paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="${HOME}/.config/opencode"

# ── Prerequisite: bun ─────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  die "bun is not installed. Install it with:\n  curl -fsSL https://bun.sh/install | bash"
fi
ok "bun $(bun --version) found"

# ── Step 1: Install dependencies ──────────────────────────────────────────────
info "Installing dependencies..."
(cd "$PROJECT_ROOT" && bun install --frozen-lockfile 2>/dev/null || bun install)
ok "Dependencies installed"

# ── Step 2: Build TypeScript ──────────────────────────────────────────────────
info "Building TypeScript..."
if grep -q '"build"' "${PROJECT_ROOT}/package.json" 2>/dev/null; then
  (cd "$PROJECT_ROOT" && bun run build)
else
  (cd "$PROJECT_ROOT" && bun run --bun tsc)
fi
ok "Build complete"

# ── Step 3: Create config directory ──────────────────────────────────────────
mkdir -p "${CONFIG_DIR}/agent"
mkdir -p "${CONFIG_DIR}/skills"

# Shared backup directory for all overwritten files
BACKUP_DIR="${CONFIG_DIR}/.backup-$(date +%Y%m%d-%H%M%S)"

# ── Step 4: Backup existing agents + Copy new ones ───────────────────────────
AGENT_SRC="${PROJECT_ROOT}/agents"
AGENT_DST="${CONFIG_DIR}/agent"
AGENT_COUNT=0
BACKED_UP=0

if [[ -d "$AGENT_SRC" ]]; then
  # Backup existing ndomo agents before overwriting
  for f in "${AGENT_SRC}"/*.md; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    if [[ -f "${AGENT_DST}/${base}" ]]; then
      if [[ $BACKED_UP -eq 0 ]]; then
        mkdir -p "${BACKUP_DIR}"
        info "Backing up existing agents to ${BACKUP_DIR}"
      fi
      cp "${AGENT_DST}/${base}" "${BACKUP_DIR}/${base}"
      BACKED_UP=$((BACKED_UP + 1))
    fi
  done
  if [[ $BACKED_UP -gt 0 ]]; then
    ok "Backed up ${BACKED_UP} existing agent(s)"
  fi

  # Copy new agents
  for f in "${AGENT_SRC}"/*.md; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    cp "$f" "${AGENT_DST}/${base}"
    AGENT_COUNT=$((AGENT_COUNT + 1))
  done
  ok "Copied ${AGENT_COUNT} agent(s) to ${AGENT_DST}"
else
  warn "No agents/ directory found in project root"
fi

# ── Step 5: Backup existing skills + Copy new ones ───────────────────────────
SKILL_SRC="${PROJECT_ROOT}/skills"
SKILL_DST="${CONFIG_DIR}/skills"
SKILL_COUNT=0
SKILL_BACKED_UP=0

if [[ -d "$SKILL_SRC" ]]; then
  for d in "${SKILL_SRC}"/*/; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    if [[ -d "${SKILL_DST}/${name}" ]]; then
      if [[ $SKILL_BACKED_UP -eq 0 ]]; then
        mkdir -p "${BACKUP_DIR}/skills"
        info "Backing up existing skills to ${BACKUP_DIR}/skills"
      fi
      cp -r "${SKILL_DST}/${name}" "${BACKUP_DIR}/skills/${name}"
      SKILL_BACKED_UP=$((SKILL_BACKED_UP + 1))
      rm -rf "${SKILL_DST}/${name}"
    fi
    cp -r "$d" "${SKILL_DST}/${name}"
    SKILL_COUNT=$((SKILL_COUNT + 1))
  done
  if [[ $SKILL_BACKED_UP -gt 0 ]]; then
    ok "Backed up ${SKILL_BACKED_UP} existing skill(s)"
  fi
  ok "Copied ${SKILL_COUNT} skill(s) to ${SKILL_DST}"
else
  warn "No skills/ directory found in project root"
fi

# ── Step 5.5: Apply provider to agent models ─────────────────────────────────
if [[ -n "$PROVIDER" && -d "$AGENT_DST" ]]; then
  cache="${HOME}/.cache/ndomo/models-catalog.json"

  # Fetch model list for chosen provider
  local_model=$(jq -r --arg p "$PROVIDER" '.providers[$p].models | to_entries | sort_by(.key) | .[0].key // empty' "$cache" 2>/dev/null) || true

  if [[ -z "$local_model" ]]; then
    local_model="default"
  fi

  if [[ "$PROVIDER_PROMPT" == true && -t 0 && -f "$cache" ]]; then
    # Interactive model selection
    printf "${BOLD}Select a model from ${PROVIDER}:${NC}\n"
    jq -r --arg p "$PROVIDER" '.providers[$p].models | to_entries | .[] | "\(.key)\t\(.value.name)"' "$cache" 2>/dev/null | \
      head -15 | nl -ba | while read -r num id _name; do
        printf "  %-4s %s\n" "$num" "$id"
      done

    read -rp "$(printf "${BOLD}Model [1-15, or type id, or Enter for first]: ${NC}")" model_choice

    if [[ -z "$model_choice" ]]; then
      chosen_model="$local_model"
    elif [[ "$model_choice" =~ ^[0-9]+$ ]]; then
      chosen_model=$(jq -r --arg p "$PROVIDER" --argjson n "$model_choice" \
        '.providers[$p].models | to_entries | .[($n - 1)].key // empty' "$cache" 2>/dev/null)
    else
      chosen_model="$model_choice"
    fi
  else
    # Non-interactive: use first model
    chosen_model="$local_model"
    if [[ "$PROVIDER_PROMPT" == true && -t 0 && ! -f "$cache" ]]; then
      warn "No catalog cache available, using default model"
    fi
  fi

  if [[ -z "${chosen_model:-}" ]]; then
    warn "Could not resolve model, skipping provider update"
  else
    full_ref="${PROVIDER}/${chosen_model}"
    info "Setting all agents to: ${full_ref}"

    updated=0
    for f in "${AGENT_DST}"/*.md; do
      [[ -f "$f" ]] || continue
      if sed -i.bak -E "0,/^model:/{s|^model:.*|model: ${full_ref}|}" "$f"; then
        rm -f "${f}.bak"
        updated=$((updated + 1))
      fi
    done
    ok "Updated ${updated} agent(s) to use ${full_ref}"
  fi
fi

# ── Step 6: Backup existing config + Copy new ones ───────────────────────────
CONFIG_JSON="${PROJECT_ROOT}/.opencode/config.json"
SCHEMA_JSON="${PROJECT_ROOT}/.opencode/ndomo.schema.json"

if [[ -f "$CONFIG_JSON" ]]; then
  if [[ -f "${CONFIG_DIR}/ndomo.json" ]]; then
    mkdir -p "${BACKUP_DIR}" 2>/dev/null
    cp "${CONFIG_DIR}/ndomo.json" "${BACKUP_DIR}/ndomo.json"
    info "Backed up existing ndomo.json"
  fi
  cp "$CONFIG_JSON" "${CONFIG_DIR}/ndomo.json"
  ok "Copied config.json -> ndomo.json"
else
  warn "No .opencode/config.json found"
fi

if [[ -f "$SCHEMA_JSON" ]]; then
  if [[ -f "${CONFIG_DIR}/ndomo.schema.json" ]]; then
    mkdir -p "${BACKUP_DIR}" 2>/dev/null
    cp "${CONFIG_DIR}/ndomo.schema.json" "${BACKUP_DIR}/ndomo.schema.json"
    info "Backed up existing ndomo.schema.json"
  fi
  cp "$SCHEMA_JSON" "${CONFIG_DIR}/ndomo.schema.json"
  ok "Copied ndomo.schema.json"
else
  warn "No .opencode/ndomo.schema.json found"
fi

# ── Step 6.5: Register ndomo plugins in opencode.json ──────────────────────
NDOMO_JSON_PATH="${CONFIG_DIR}/ndomo.json"
OPENCODE_JSON_PATH="${CONFIG_DIR}/opencode.json"

if command -v jq &>/dev/null; then
  # Create opencode.json if missing
  [[ -f "$OPENCODE_JSON_PATH" ]] || echo '{}' > "$OPENCODE_JSON_PATH"

  # Backup opencode.json if not already backed up
  if [[ -f "$OPENCODE_JSON_PATH" ]]; then
    if [[ ! -f "${BACKUP_DIR}/opencode.json" ]]; then
      mkdir -p "${BACKUP_DIR}" 2>/dev/null
      cp "$OPENCODE_JSON_PATH" "${BACKUP_DIR}/opencode.json"
      info "Backed up opencode.json"
    fi
  fi

  if [[ -f "$NDOMO_JSON_PATH" ]]; then
    # Extract plugin list (deduped union of plugins + optionalPlugins)
    PLUGIN_LIST=$(jq -r '
      ((.plugins // []) + (.optionalPlugins // [])) | unique | .[]
    ' "$NDOMO_JSON_PATH" 2>/dev/null) || true

    if [[ -n "$PLUGIN_LIST" ]]; then
      # Build JSON array
      NEW_PLUGINS_JSON=$(printf '%s\n' "$PLUGIN_LIST" | jq -R . | jq -s 'map(select(. != "" and . != null))')

      # Merge (unique handles idempotency)
      jq --argjson new "$NEW_PLUGINS_JSON" '
        .plugin = ((.plugin // []) + $new | unique)
      ' "$OPENCODE_JSON_PATH" > "${OPENCODE_JSON_PATH}.tmp" \
        && mv "${OPENCODE_JSON_PATH}.tmp" "$OPENCODE_JSON_PATH"

      ok "Registered $(echo "$PLUGIN_LIST" | wc -l) ndomo plugin(s) in opencode.json"
    else
      info "No ndomo plugins found to register"
    fi
  else
    warn "ndomo.json not found, skipping plugin registration"
  fi
else
  warn "jq not found, skipping opencode.json plugin registration"
fi

# ── Step 7: Apply preset ─────────────────────────────────────────────────────
if [[ "$PRESET" == "budget" ]]; then
  NDOMO_JSON="${CONFIG_DIR}/ndomo.json"
  if [[ -f "$NDOMO_JSON" ]]; then
    # Inject "preset": "budget" into the top-level object
    if command -v jq &>/dev/null; then
      jq --arg p "$PRESET" '. + {preset: $p}' "$NDOMO_JSON" > "${NDOMO_JSON}.tmp" \
        && mv "${NDOMO_JSON}.tmp" "$NDOMO_JSON"
    else
      # Fallback: insert after the opening brace
      sed -i 's/^{/{\n  "preset": "budget",/' "$NDOMO_JSON"
    fi
    ok "Preset set to '${PRESET}'"
  fi
fi

# ── Step 8: Optional DCP install ─────────────────────────────────────────────
if [[ "$WITH_DCP" == true ]]; then
  info "Installing @tarquinen/opencode-dcp (AGPL-3.0)..."
  opencode plugin @tarquinen/opencode-dcp --global
  ok "DCP plugin installed"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
printf "${GREEN}${BOLD}════════════════════════════════════════${NC}\n"
printf "${GREEN}${BOLD}  ndomo installed successfully!${NC}\n"
printf "${GREEN}${BOLD}════════════════════════════════════════${NC}\n"
echo ""
printf "${BOLD}Installed agents:${NC}\n"
printf "  %-20s %s\n" "Agent" "File"
printf "  %-20s %s\n" "─────" "────"
for f in "${AGENT_DST}"/*.md; do
  [[ -f "$f" ]] || continue
  base="$(basename "$f")"
  name="${base%.md}"
  printf "  %-20s %s\n" "$name" "$base"
done
echo ""
printf "${BOLD}Installed skills:${NC} "
# shellcheck disable=SC2012
ls -1 "${SKILL_DST}" 2>/dev/null | tr '\n' ', ' | sed 's/, $//'
echo ""
echo ""
printf "${BOLD}Config:${NC} ${CONFIG_DIR}/ndomo.json\n"
printf "${BOLD}OpenCode config:${NC} ${CONFIG_DIR}/opencode.json (ndomo registered)\n"
printf "${BOLD}Preset:${NC} ${PRESET}\n"
if [[ -n "${PROVIDER:-}" ]]; then
  printf "${BOLD}Provider:${NC} ${PROVIDER}\n"
fi
if [[ "$WITH_DCP" == true ]]; then
  printf "${BOLD}DCP:${NC}    installed\n"
fi
echo ""
printf "${BOLD}Next steps:${NC}\n"
printf "  Run ${BLUE}opencode${NC} then ${BLUE}ping all agents${NC} to verify.\n"
echo ""

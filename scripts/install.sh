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

# Escape characters that have special meaning in sed replacement strings.
# Usage: sed_escape <value>
sed_escape() {
  # Order matters: escape backslashes first, then & and the delimiter.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/|/\\|/g' -e 's/&/\\&/g'
}

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
    warn "Skipping provider selection — agents will use preset models"
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

# ── Preset application ───────────────────────────────────────────────────────
# Apply preset models/temperature from ndomo.config.json to agent .md files
apply_preset() {
  local preset="$1"
  local config_json="$2"
  local agent_dst="$3"
  local updated=0
  local skipped=0
  local f base name model temp effort

  for f in "${agent_dst}"/*.md; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    name="${base%.md}"

    # Prevent path traversal: reject names with slashes, dots, or special chars
    if [[ ! "$name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
      warn "Skipping invalid agent name in filename: '$name'"
      skipped=$((skipped + 1))
      continue
    fi

    model=$(jq -r --arg preset "$preset" --arg name "$name" \
      '.presets[$preset][$name].model // empty' "$config_json" 2>/dev/null || true)
    temp=$(jq -r --arg preset "$preset" --arg name "$name" \
      '.presets[$preset][$name].temperature // empty' "$config_json" 2>/dev/null || true)
    effort=$(jq -r --arg preset "$preset" --arg name "$name" \
      '.presets[$preset][$name].reasoning_effort // empty' "$config_json" 2>/dev/null || true)

    if [[ -z "$model" ]]; then
      warn "Agent '${name}' has no entry in preset '${preset}', skipping"
      skipped=$((skipped + 1))
      continue
    fi

    local esc_model esc_temp esc_effort
    esc_model=$(sed_escape "$model")
    esc_temp=$(sed_escape "$temp")
    esc_effort=$(sed_escape "$effort")
    sed -i.bak -E "0,/^model:/{s|^model:.*|model: ${esc_model}|}" "$f"
    if [[ -n "$temp" ]]; then
      sed -i.bak -E "0,/^temperature:/{s|^temperature:.*|temperature: ${esc_temp}|}" "$f"
    fi
    # reasoning_effort: snake_case in ndomo config -> camelCase reasoningEffort in agent frontmatter
    if [[ -n "$effort" ]]; then
      if grep -qE '^reasoningEffort:[[:space:]]' "$f"; then
        sed -i.bak -E "0,/^reasoningEffort:[[:space:]].*\$/{s|^reasoningEffort:[[:space:]].*\$|reasoningEffort: ${esc_effort}|;}" "$f" && rm -f "${f}.bak"
      else
        if grep -qE '^temperature:[[:space:]]' "$f"; then
          sed -i.bak -E "0,/^temperature:[[:space:]].*\$/{s|(^temperature:[[:space:]].*\$)|\1\nreasoningEffort: ${esc_effort}|;}" "$f" && rm -f "${f}.bak"
        elif grep -qE '^model:[[:space:]]' "$f"; then
          sed -i.bak -E "0,/^model:[[:space:]].*\$/{s|(^model:[[:space:]].*\$)|\1\nreasoningEffort: ${esc_effort}|;}" "$f" && rm -f "${f}.bak"
        else
          sed -i.bak -E "0,/^---\$/{s|(^---\$)|\1\nreasoningEffort: ${esc_effort}|;}" "$f" && rm -f "${f}.bak"
        fi
      fi
    fi
    rm -f "${f}.bak"
    updated=$((updated + 1))
  done

  echo "$updated $skipped"
}

# Swap only the provider/ prefix on model: lines — preserves model ID from preset
apply_provider_prefix() {
  local provider="$1"
  local agent_dst="$2"
  local updated=0
  local f

  for f in "${agent_dst}"/*.md; do
    [[ -f "$f" ]] || continue
    local esc_provider
    esc_provider=$(sed_escape "$provider")
    if sed -i.bak -E "0,/^model:/{s|^model: [^/]+/|model: ${esc_provider}/|}" "$f" 2>/dev/null; then
      rm -f "${f}.bak"
      updated=$((updated + 1))
    fi
  done

  echo "$updated"
}

# Print a table: agent | preset model | current provider prefix (for TTY flow)
show_preset_table() {
  local preset="$1"
  local config_json="$2"
  local agent_dst="$3"
  local name preset_model current_prefix sep

  sep="$(printf '%.0s─' {1..20})"
  printf "\n${BOLD}Preset '${preset}' — agent model overview:${NC}\n"
  printf "  ${BOLD}%-20s %-35s %s${NC}\n" "Agent" "Preset Model" "Current Prefix"
  printf "  %-20s %-35s %s\n" "$sep" "$(printf '%.0s─' {1..35})" "$(printf '%.0s─' {1..20})"

  for f in "${agent_dst}"/*.md; do
    [[ -f "$f" ]] || continue
    name="$(basename "$f" .md)"
    preset_model=$(jq -r --arg preset "$preset" --arg name "$name" \
      '.presets[$preset][$name].model // empty' "$config_json" 2>/dev/null || true)
    current_prefix=$(sed -n 's/^model: *\([^/]*\)\/.*/\1/p' "$f" 2>/dev/null || echo "none")
    [[ -n "$preset_model" ]] && printf "  %-20s %-35s %s\n" "$name" "$preset_model" "${current_prefix:-none}"
  done
}

# Install ndomo package into ~/.config/opencode/node_modules/
# Strategy order (avoids Bun cache stale with symlinks — see docs/installation.md):
#   1. file: dep + bun install → real copy in node_modules (best, no symlink)
#   2. bun link → managed symlink (second best, bun-tracked)
#   3. manual symlink → last resort only (may cause Bun cache stale)
install_ndomo_package() {
  local project_root="$1"
  local config_dir="$2"
  local pkg_json="$config_dir/package.json"
  local nm_ndomo="$config_dir/node_modules/ndomo"

  # Skip if user opted out
  if [[ "${NDOMO_SKIP_PACKAGE_INSTALL:-0}" == "1" ]]; then
    info "skipping ndomo package install (NDOMO_SKIP_PACKAGE_INSTALL=1)"
    return 0
  fi

  # If existing install is a symlink, remove it — symlinks cause Bun cache stale
  if [[ -L "$nm_ndomo" ]]; then
    warn "existing ndomo install is a symlink (causes Bun cache stale in dev)"
    info "removing symlink, will reinstall as real copy..."
    rm -f "$nm_ndomo"
  elif [[ -e "$nm_ndomo" ]]; then
    info "ndomo already installed at $nm_ndomo"
    return 0
  fi

  # Need package.json in config dir for bun-based strategies
  if [[ ! -f "$pkg_json" ]]; then
    warn "$pkg_json not found, falling back to manual symlink"
    mkdir -p "$config_dir/node_modules"
    ln -sfn "$project_root" "$nm_ndomo"
    ok "ndomo symlinked at $nm_ndomo (last resort — no package.json)"
    warn "symlink install may cause Bun cache stale — run 'bun run dev:bust' to recover"
    return 0
  fi

  # Strategy 1: file: dep + bun install → real copy (no symlink, no cache stale)
  if command -v bun >/dev/null 2>&1; then
    info "adding ndomo file: dep to $pkg_json"
    if jq --arg path "$project_root" '.dependencies.ndomo = ("file://" + $path)' "$pkg_json" > "$pkg_json.tmp" && mv "$pkg_json.tmp" "$pkg_json"; then
      if (cd "$config_dir" && bun install --no-frozen-lockfile 2>&1); then
        if [[ -e "$nm_ndomo" ]] && [[ ! -L "$nm_ndomo" ]]; then
          ok "ndomo installed via bun (file: dep) — real copy, no symlink"
          return 0
        fi
      fi
      warn "bun install did not materialize ndomo as real copy, trying bun link..."
    else
      warn "jq update of $pkg_json failed, trying bun link..."
    fi
  else
    warn "bun not found in PATH, using symlink fallback"
  fi

  # Strategy 2: bun link → managed symlink (bun-tracked, better than manual)
  if command -v bun >/dev/null 2>&1; then
    info "trying bun link..."
    if (cd "$project_root" && bun link 2>&1) && (cd "$config_dir" && bun link ndomo 2>&1); then
      if [[ -e "$nm_ndomo" ]]; then
        ok "ndomo linked via bun link (managed symlink)"
        warn "bun link uses symlinks — run 'bun run dev:bust' if cache goes stale"
        return 0
      fi
    fi
    warn "bun link failed, falling back to manual symlink"
  fi

  # Strategy 3: manual symlink (last resort)
  info "creating manual symlink: $nm_ndomo -> $project_root"
  mkdir -p "$config_dir/node_modules"
  if ln -sfn "$project_root" "$nm_ndomo"; then
    ok "ndomo symlinked at $nm_ndomo (last resort)"
    warn "manual symlink may cause Bun cache stale — run 'bun run dev:bust' to recover"
  else
    die "failed to install ndomo package"
  fi
}

# Symlink project tools/ -> ~/.config/opencode/tools/ for OpenCode custom tools
install_custom_tools_symlink() {
  local project_root="$1"
  local config_dir="$2"
  local src="$project_root/tools"
  local dst="$config_dir/tools"

  if [[ ! -d "$src" ]]; then
    warn "No tools/ directory found at $src — skipping"
    return 0
  fi

  if [[ -e "$dst" ]]; then
    if [[ -L "$dst" ]] && [[ "$(readlink "$dst")" == "$src" ]]; then
      ok "Custom tools symlink already in place: $dst -> $src"
      return 0
    fi
    if [[ -d "$dst" ]] && [[ ! -L "$dst" ]]; then
      warn "Custom tools directory already exists at $dst (not a symlink) — skipping"
      return 0
    fi
  fi

  mkdir -p "$config_dir"
  ln -sfn "$src" "$dst"
  ok "Symlinked custom tools: $dst -> $src"
}

usage() {
  cat <<EOF
${BOLD}ndomo installer — agent preset & provider tool${NC}

${BOLD}Usage:${NC}
  ./install.sh [OPTIONS]
  curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s [-- OPTIONS]

${BOLD}Options:${NC}
  --with-dcp            Also install @tarquinen/opencode-dcp (AGPL-3.0 peer)
  --preset=NAME         Use preset from ndomo.config.json (default: "default", options: "default", "budget")
  --provider=ID         Override provider prefix on preset models (e.g., opencode, anthropic, openai)
  --no-provider-prompt  Skip interactive provider override prompt
  --repo=URL            Override repository URL (for piped installs)
  --branch=NAME         Override repository branch (for piped installs)
  --uninstall           Run uninstaller instead
  --help                Show this help

${BOLD}Environment:${NC}
  NDOMO_SKIP_PACKAGE_INSTALL=1  Skip automatic ndomo package installation into
                                ~/.config/opencode/ (advanced users only)

${BOLD}Examples:${NC}
  ./install.sh                          # apply presets.default from ndomo.config.json
  ./install.sh --preset=budget          # apply presets.budget
  ./install.sh --provider=opencode      # apply preset, swap provider prefix to opencode/
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

# ── Step 5.5: Apply preset + optional provider prefix override ──────────────
# Always apply preset models/temperature from ndomo.config.json
CONFIG_JSON="${PROJECT_ROOT}/config/ndomo.config.json"
if [[ -d "$AGENT_DST" ]]; then
  if ! command -v jq &>/dev/null; then
    warn "jq not found, skipping preset application"
  else
    should_apply_preset=true
    provider_prefix=""

    if [[ -n "$PROVIDER" ]]; then
      # --provider=ID: apply preset + prefix override
      info "Provider prefix '${PROVIDER}' specified via --provider"
      provider_prefix="$PROVIDER"
    elif [[ -t 0 && "$PROVIDER_PROMPT" == true && "${PIPED:-false}" != "true" ]]; then
      # TTY interactive: show table and ask
      show_preset_table "$PRESET" "$CONFIG_JSON" "$AGENT_DST"
      echo ""
      read -rp "$(printf "${BOLD}Apply preset '${PRESET}' as configured? [Y/n/override]: ${NC}")" user_choice

      case "${user_choice,,}" in
        n|no)
          warn "Preset application skipped by user"
          should_apply_preset=false
          ;;
        override|o)
          info "Opening provider selector for prefix override..."
          select_provider || true
          if [[ -n "${PROVIDER:-}" ]]; then
            provider_prefix="$PROVIDER"
          else
            warn "Provider selection failed — applying preset without prefix override"
          fi
          ;;
        *) # Y/yes/enter → apply preset, no prefix override
          ;;
      esac
    fi

    if [[ "$should_apply_preset" == true ]]; then
      # Apply preset models + temperatures
      result=$(apply_preset "$PRESET" "$CONFIG_JSON" "$AGENT_DST")
      updated="${result%% *}"
      skipped="${result##* }"
      ok "Applied preset '${PRESET}' — ${updated} agent(s) updated"
      if [[ "$skipped" -gt 0 ]]; then
        warn "${skipped} agent(s) skipped (no entry in preset '${PRESET}')"
      fi

      # Apply provider prefix override if requested
      if [[ -n "$provider_prefix" ]]; then
        updated_p=$(apply_provider_prefix "$provider_prefix" "$AGENT_DST")
        ok "Provider prefix override '${provider_prefix}/' applied to ${updated_p} agent(s)"
      fi
    fi
  fi
fi

# ── Step 6: Backup existing config + Copy new ones ───────────────────────────
CONFIG_JSON="${PROJECT_ROOT}/config/ndomo.config.json"
SCHEMA_JSON="${PROJECT_ROOT}/config/ndomo.schema.json"

if [[ -f "$CONFIG_JSON" ]]; then
  if [[ -f "${CONFIG_DIR}/ndomo.json" ]]; then
    mkdir -p "${BACKUP_DIR}" 2>/dev/null
    cp "${CONFIG_DIR}/ndomo.json" "${BACKUP_DIR}/ndomo.json"
    info "Backed up existing ndomo.json"
  fi
  cp "$CONFIG_JSON" "${CONFIG_DIR}/ndomo.json"
  ok "Copied config.json -> ndomo.json"
else
  warn "No config/ndomo.config.json found"
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
  warn "No config/ndomo.schema.json found"
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

# ── Step 6.6: Install ndomo package in ~/.config/opencode/ ──────────────────
install_ndomo_package "$PROJECT_ROOT" "$CONFIG_DIR"

# ── Step 6.7: Symlink custom tools ──────────────────────────────────────────
install_custom_tools_symlink "$PROJECT_ROOT" "$CONFIG_DIR"

# ── Step 7: Inject preset name into ndomo.json ──────────────────────────────
NDOMO_JSON="${CONFIG_DIR}/ndomo.json"
if [[ -f "$NDOMO_JSON" ]]; then
  if command -v jq &>/dev/null; then
    jq --arg p "$PRESET" '. + {preset: $p}' "$NDOMO_JSON" > "${NDOMO_JSON}.tmp" \
      && mv "${NDOMO_JSON}.tmp" "$NDOMO_JSON"
  else
    # Fallback: insert after the opening brace
    sed -i "s/^{/{\n  \"preset\": \"${PRESET}\",/" "$NDOMO_JSON"
  fi
  ok "Preset '${PRESET}' written to ndomo.json"
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

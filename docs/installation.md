# Installation Guide

## Prerequisites

- **bun** >= 1.1.0 — [install bun](https://bun.sh)
- **OpenCode** installed and configured
- At least one **provider authenticated** in OpenCode (the agents will use provider models)

Verify prerequisites:

```bash
bun --version  # >= 1.1.0
opencode --version
opencode config list providers  # should show at least one authenticated provider
```

## Install via curl/wget

The install script supports being piped directly from a URL, useful for quick setups, CI/CD pipelines, and ephemeral environments. When piped, the script detects it is running from stdin, clones the repository to `/tmp`, and re-executes itself.

```bash
# Quick install (interactive, will prompt for provider)
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash

# Non-interactive with provider preset
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- --provider=opencode --no-provider-prompt

# With budget preset + DCP
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- --preset=budget --with-dcp

# Install from a fork or dev branch
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- \
  --repo=https://github.com/myorg/ndomo-fork \
  --branch=dev \
  --provider=opencode
```

The `--repo` and `--branch` flags are only relevant in piped mode; they are ignored when running from a local clone.

## Install from Git Clone

```bash
# 1. Clone the repository
git clone <repo-url> ndomo
cd ndomo

# 2. Install dependencies
bun install

# 3. Run the install script
./scripts/install.sh
```

The install script:
1. Copies the configuration to `~/.config/opencode/ndomo.json`
2. Registers the plugin with OpenCode
3. Verifies all agent definitions in `agents/` are valid
4. Links the bundled skills (bash-scripting, caveman, grill-me, and 20+ others from `skills/`) to the OpenCode skills directory
5. Applies the active preset (`presets[PRESET]` from `ndomo.config.json`) to every agent's `model:` and `temperature:` frontmatter.
6. Registers `ndomo` as a local `file:` dependency in `~/.config/opencode/package.json` and installs it to `~/.config/opencode/node_modules/ndomo/` via `bun install`. This is what allows OpenCode to resolve the plugin from `plugin: ["ndomo", ...]` and register its tools. See [OpenCode plugin docs](https://opencode.ai/docs/es/plugins/) and [custom tools docs](https://opencode.ai/docs/es/custom-tools/).
7. Symlinks the bundled custom tools (14 DB access tools: `plan_*`, `task_*`, `session_*`) from `tools/` to `~/.config/opencode/tools/`. See [OpenCode custom tools docs](https://opencode.ai/docs/es/custom-tools/).

**Note:** The `reasoning_effort` field (optional, `low`|`medium`|`high`|`xhigh`) is supported for reasoning-capable models (DeepSeek, MiMo, OpenAI). Omit it for non-reasoning models.

## Install Flags

| Flag | Description |
|---|---|
| `--provider=ID` | Override the provider prefix for all agents. The model ID is taken from the active preset; only the `provider/` segment of the `model:` field is swapped. Example: preset gives `opencode-go/minimax-m2.7`, `--provider=opencode` rewrites to `opencode/minimax-m2.7`. |
| `--no-provider-prompt` | Skip the interactive provider prompt. The preset is still applied; no provider prefix override is performed. |
| `--with-dcp` | Install and configure the DCP plugin (opencode-dynamic-context-pruning) as an optional peer dependency |
| `--preset=NAME` | Select preset from `config/ndomo.config.json::presets[NAME]`. The preset is the source of truth for agent models at install time. (default: `default`, options: `default`, `budget`) |
| `--repo=URL` | Override the repository URL (for piped installs from a fork or mirror). Ignored in local clones. |
| `--branch=NAME` | Override the repository branch (for piped installs from `dev`/`feature/*` branches). Ignored in local clones. |

**Environment variable:** `NDOMO_SKIP_PACKAGE_INSTALL=1` — skip the package installation step (`bun install` in `~/.config/opencode/`). Useful if you manage the OpenCode plugin directory manually or if the install step is causing conflicts.

Example with all flags:

```bash
# Local clone with all flags
./scripts/install.sh --with-dcp --preset=budget

# Piped install with provider, fork, and custom branch
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- \
  --repo=https://github.com/myorg/ndomo-fork \
  --branch=dev \
  --provider=opencode \
  --no-provider-prompt
```

## Provider Override

When `install.sh` runs without `--provider` and without `--no-provider-prompt`, it shows the active preset and asks for confirmation. The active preset is the single source of truth for agent models; `--provider=ID` only changes the provider prefix.

TTY flow:

1. The script prints a table of `(agent, preset model, current provider prefix)` derived from `config/ndomo.config.json`.
2. It asks: `Apply preset '$PRESET' as configured? [Y/n/override]`
3. `Y` (or Enter) applies the preset, no prefix override.
4. `n` skips preset application (warn).
5. `override` enters the interactive provider picker from models.dev and applies a prefix override to every agent's `model:` field. The model ID comes from the preset; only the `provider/` segment is swapped.

To skip the prompt and apply the preset silently:

```bash
./scripts/install.sh --no-provider-prompt
```

To override the provider prefix non-interactively (e.g., use `opencode` instead of `opencode-go` for all agents):

```bash
./scripts/install.sh --provider=opencode
```

The provider override works in piped mode:

```bash
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- --provider=opencode --no-provider-prompt
```

## Verify Installation

1. Start OpenCode:

```bash
opencode
```

2. Inside the OpenCode session, test agent communication:

```
ping all agents
```

Expected output: each of the 14 agents responds with a status confirmation.

3. Check that the Foreman is the primary agent:

```
/agent
```

Should show `foreman` as the active agent.

4. Verify the ndomo DB was created:

   ```bash
   ls -la .ndomo/state.db
   ```

   The plugin creates this SQLite database automatically on first load. It
   stores plans, tasks, and sessions. See [docs/database.md](docs/database.md)
   for details.

## Uninstall

```bash
./scripts/uninstall.sh
```

Removes:
- The config file at `~/.config/opencode/ndomo.json`
- Plugin registration from OpenCode
- Skill symlinks

**Flag:**

| Flag | Description |
|---|---|
| `--keep-data` | Remove plugin config but preserve memory files in `~/.ndomo/mem/` |

## Troubleshooting

### bun not found

```
bun: command not found
```

Install bun: `curl -fsSL https://bun.sh/install | bash`. Restart your shell after installation.

### Provider not authenticated

```
Error: No authenticated provider found
```

Configure a provider in OpenCode: `opencode config set provider <provider-name>` and follow the authentication flow. At least one provider must be authenticated before ndomo agents can make API calls.

### Agent not responding

If `ping all agents` shows no response from one or more agents:

1. Verify the config file exists: `ls ~/.config/opencode/ndomo.json`
2. Validate the config against the schema: `cat ~/.config/opencode/ndomo.json`
3. Re-run the install script: `./scripts/install.sh`
4. Check OpenCode logs for model routing errors — the agent's `model` field in the config must match a model available through your authenticated provider.

### Permission denied on scripts

```bash
chmod +x scripts/install.sh scripts/uninstall.sh
```

### Plugin not loading

If OpenCode doesn't detect ndomo as a plugin:

1. Ensure `ndomo` is listed in `config/ndomo.config.json` under `plugins`
2. Check that the package is installed: `ls ~/.config/opencode/node_modules/ndomo/` — if missing, re-run `./scripts/install.sh` or symlink manually: `ln -sfn $(pwd) ~/.config/opencode/node_modules/ndomo`
3. Verify the plugin entry point (`src/index.ts`) compiles without errors: `bun run build`
4. Check that the local node_modules were installed: `ls node_modules/ndomo` (or the symlink target)

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
4. Links the bundled skills to the OpenCode skills directory

## Install Flags

| Flag | Description |
|---|---|
| `--provider=ID` | Set the model provider for all agents (e.g., `opencode`, `anthropic`, `openai`). Without this flag, the interactive provider picker shows the top 20 providers from models.dev. |
| `--no-provider-prompt` | Skip the interactive provider picker. Use the default provider (whatever each agent has in its frontmatter). |
| `--with-dcp` | Install and configure the DCP plugin (opencode-dynamic-context-pruning) as an optional peer dependency |
| `--preset=default` | Use full models for all agents (minimax/MiniMax-M3 foreman, opencode-go models, xiaomi stack-smiths) |
| `--preset=budget` | Use deepseek-v4-flash for all agents to reduce API costs |
| `--repo=URL` | Override the repository URL (for piped installs from a fork or mirror). Ignored in local clones. |
| `--branch=NAME` | Override the repository branch (for piped installs from `dev`/`feature/*` branches). Ignored in local clones. |

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

## Provider Selection

When `install.sh` runs without `--provider` and without `--no-provider-prompt`, it enters interactive provider selection mode:

1. The script fetches `https://models.dev/catalog.json` and caches it at `~/.cache/ndomo/models-catalog.json`.
2. It displays the top 20 providers from the catalog as a numbered list.
3. You select a provider by entering its number or ID.
4. **Step 5.5** of the install script applies the selected provider to all agent definitions by replacing the `model:` field in each agent's frontmatter (`agents/*.md`) with `<selected-provider>/<existing-model-id>`.

This means every agent retains its original model ID but uses the selected provider as the prefix. For example, selecting `opencode` transforms `minimax/MiniMax-M3` into `opencode/MiniMax-M3` for all agents.

To skip provider selection and keep each agent's original `model:` value, pass `--no-provider-prompt`:

```bash
./scripts/install.sh --no-provider-prompt
```

To set a specific provider non-interactively:

```bash
./scripts/install.sh --provider=anthropic
```

The provider selection also works in piped mode:

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
2. Verify the plugin entry point (`src/index.ts`) compiles without errors: `bun run build`
3. Check that the node_modules were installed: `ls node_modules/ndomo` (or the symlink target)

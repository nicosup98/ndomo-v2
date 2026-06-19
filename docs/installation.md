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
| `--with-dcp` | Install and configure the DCP plugin (opencode-dynamic-context-pruning) as an optional peer dependency |
| `--preset=default` | Use full models for all agents (minimax/MiniMax-M3 foreman, opencode-go models, xiaomi stack-smiths) |
| `--preset=budget` | Use deepseek-v4-flash for all agents to reduce API costs |

Example with all flags:

```bash
./scripts/install.sh --with-dcp --preset=budget
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

1. Ensure `ndomo` is listed in `.opencode/config.json` under `plugins`
2. Verify the plugin entry point (`src/index.ts`) compiles without errors: `bun run build`
3. Check that the node_modules were installed: `ls node_modules/ndomo` (or the symlink target)

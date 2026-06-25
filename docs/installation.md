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

## Install via bunx

The TS installer is distributed as a `bunx ndomo` one-shot. It applies the active preset from `config/ndomo.config.json`, copies agents/skills/config to OpenCode's user config dir, and prompts interactively for HTTP server enablement.

```bash
# Quick install (interactive, will prompt for HTTP)
bunx ndomo install

# Non-interactive with provider preset + HTTP enabled
bunx ndomo install --provider=opencode --no-provider-prompt --enable-http

# With budget preset + DCP
bunx ndomo install --preset=budget --with-dcp
```

See [docs/installer.md](installer.md) for the full flag reference.

## Install from Git Clone

```bash
# 1. Clone the repository
git clone <repo-url> ndomo
cd ndomo

# 2. Install dependencies
bun install

# 3. Run the install script
bunx ndomo install
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

## Development Workflow

When developing ndomo (editing agents, skills, config, or source files), use these commands to apply changes:

| Command | When to use | What it does |
|---|---|---|
| `./scripts/install.sh` or `bunx ndomo install` | First install, after cloning, or after changing agents/skills/config | Copies agents, skills, and config to `~/.config/opencode/`. Installs ndomo package. Always preferred for structural changes. |
| `bun run dev:bust` | After editing only `src/*.ts` source files (no agent/skill/config changes) | Quick cache bust: removes stale Bun transpiler cache entries referencing ndomo, bumps mtime on all `src/*.ts` files. Does not kill opencode. |
| `bun run dev:reset` | Same as `dev:bust` but when opencode is running and you need a clean restart | `dev:bust` + kills running opencode processes. Run this after editing source to ensure the next `opencode` picks up fresh code. |

### Daily dev loop

1. Edit source files in `src/`.
2. Run `bun run dev:reset` to kill opencode + bust Bun cache + bump mtimes.
3. Start opencode: `opencode`.
4. Repeat.

### Why symlinks cause stale cache

Bun caches transpiled TypeScript modules in `~/.bun/install/cache/` keyed by the **resolved path** of the module. When ndomo is installed via a symlink (e.g., `~/.config/opencode/node_modules/ndomo → /home/nico/ndomo`), the cache key uses the symlink path. Editing source files on the target filesystem does **not** change the symlink path, so Bun serves stale code from cache.

The `file:` dep strategy in `install_ndomo_package()` avoids this by creating a real copy in `node_modules` (no symlink → no stale cache). If you ever end up with a symlink install (from an older `install.sh` version or a manual `ln -s`), re-run `bunx ndomo install` — the installer detects the symlink, removes it, and reinstalls as a real copy.

### Manual cache busting (advanced)

Run the cache bust script directly for more control:

```bash
# Dry-run — inspect what would be removed
./scripts/dev-bust-cache.sh

# Apply — remove stale cache entries + bump mtimes
./scripts/dev-bust-cache.sh --apply

# Kill opencode first, then bust cache
./scripts/dev-bust-cache.sh --apply --kill
```

The script (`scripts/dev-bust-cache.sh`):
1. Optionally kills running opencode processes (`--kill`)
2. Removes Bun cache entries referencing "ndomo"
3. Removes Bun cache entries referencing the ndomo source path (`$PROJECT_ROOT/src`)
4. Touches all `src/*.ts` files to bump mtime (forces re-transpilation)

It is **idempotent** — safe to run multiple times. No-op if the cache is already clean.

## Install Flags

| Flag | Description |
|---|---|
| `--provider=ID` | Override the provider prefix for all agents. The model ID is taken from the active preset; only the `provider/` segment of the `model:` field is swapped. Example: preset gives `opencode-go/minimax-m2.7`, `--provider=opencode` rewrites to `opencode/minimax-m2.7`. |
| `--no-provider-prompt` | Skip the interactive provider prompt. The preset is still applied; no provider prefix override is performed. |
| `--with-dcp` | Install and configure the DCP plugin (opencode-dynamic-context-pruning) as an optional peer dependency |
| `--preset=NAME` | Select preset from `config/ndomo.config.json::presets[NAME]`. The preset is the source of truth for agent models at install time. (default: `default`, options: `default`, `budget`) |
| `--dry-run` | Print planned changes without writing files. |
| `--skip-deps` | Skip the dependency installation step (`bun install`). |
| `--enable-http` | Automatically enable the HTTP server (writes http block to `ndomo.config.json`). |
| `--disable-http` | Skip the automatic HTTP prompt entirely (default in non-TTY / CI). |
| `--port=N` | HTTP server port (default: `4097`). |
| `--cors-origins=CSV` | HTTP CORS origins, comma-separated (default: `*`). |
| `--auth-required=BOOL` | HTTP auth requirement (default: `true`). |
| `--uninstall` | Uninstall ndomo (remove config, plugin registration, skill symlinks). |

**Environment variable:** `NDOMO_SKIP_PACKAGE_INSTALL=1` — skip the package installation step (`bun install` in `~/.config/opencode/`). Useful if you manage the OpenCode plugin directory manually or if the install step is causing conflicts.

Example with all flags:

```bash
# Local clone with HTTP + DCP + budget preset
bunx ndomo install --with-dcp --preset=budget --enable-http --port=4097
```

## Provider Override

When the installer runs without `--provider` and without `--no-provider-prompt`, it shows the active preset and asks for confirmation. The active preset is the single source of truth for agent models; `--provider=ID` only changes the provider prefix.

TTY flow:

1. The installer prints a table of `(agent, preset model, current provider prefix)` derived from `config/ndomo.config.json`.
2. It asks: `Apply preset '$PRESET' as configured? [Y/n/override]`
3. `Y` (or Enter) applies the preset, no prefix override.
4. `n` skips preset application (warn).
5. `override` enters the interactive provider picker from models.dev and applies a prefix override to every agent's `model:` field. The model ID comes from the preset; only the `provider/` segment is swapped.

To skip the prompt and apply the preset silently:

```bash
bunx ndomo install --no-provider-prompt
```

To override the provider prefix non-interactively (e.g., use `opencode` instead of `opencode-go` for all agents):

```bash
bunx ndomo install --provider=opencode
```

The provider override works in piped mode:

```bash
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- --provider=opencode --no-provider-prompt
```

> **Note:** The piped curl|bash method is deprecated. Use `bunx ndomo install --provider=opencode` instead.

## Migration from curl|bash

If you previously installed ndomo via piped curl|bash, migrate with:

```bash
# Old (deprecated, prints warning)
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash

# New (recommended)
bunx ndomo install
```

The TS installer covers all flows that the bash script did — local clone, piped install, provider override, preset selection, DCP plugin, plus new HTTP auto-prompt. See [docs/installer.md](installer.md).

## Legacy bash installer (deprecated)

`scripts/install.sh` is preserved as a compat shim with a deprecation warning header. It still works for one major version but new installs should use `bunx ndomo install`. The shim re-execs the TS installer after printing the warning.

## Verify Installation

1. Start OpenCode:

```bash
opencode
```

2. Inside the OpenCode session, test agent communication:

```
ping all agents
```

Expected output: each of the 22 agents responds with a status confirmation.

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
bunx ndomo install --uninstall
```

Or using the legacy bash script:

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
3. Re-run the install script: `bunx ndomo install`
4. Check OpenCode logs for model routing errors — the agent's `model` field in the config must match a model available through your authenticated provider.

### Permission denied on scripts

```bash
chmod +x scripts/install.sh scripts/uninstall.sh
```

### Plugin not loading

If OpenCode doesn't detect ndomo as a plugin:

1. Ensure `ndomo` is listed in `config/ndomo.config.json` under `plugins`
2. Check that the package is installed: `ls ~/.config/opencode/node_modules/ndomo/` — if missing, re-run `bunx ndomo install` or symlink manually: `ln -sfn $(pwd) ~/.config/opencode/node_modules/ndomo`
3. Verify the plugin entry point (`src/index.ts`) compiles without errors: `bun run build`
4. Check that the local node_modules were installed: `ls node_modules/ndomo` (or the symlink target)

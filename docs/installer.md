# ndomo Installer Reference

TypeScript installer for ndomo. Replaces the legacy `scripts/install.sh` (now deprecated).

## Overview

`bunx ndomo install` installs agents, skills, and config into `~/.config/opencode/`. It performs the same phases as the bash installer:

1. Dependency installation (`bun install`)
2. TypeScript build
3. Agent `.md` files copy with timestamped backups
4. Skill directories copy with timestamped backups
5. Preset application (model, temperature, reasoningEffort per agent)
6. Provider prefix override (optional)
7. Config file copy (`ndomo.config.json` -> `ndomo.json`)
8. Plugin registration in `opencode.json`
9. Package install via 3-strategy cascade (file: dep -> bun link -> manual symlink)
10. Tool files copy
11. Preset injection into `ndomo.json`
12. Optional DCP plugin install

**Invocation:**

```bash
# Via npm distribution
bunx ndomo install [OPTIONS]

# From local clone
bun run src/cli/install.ts [OPTIONS]
```

## Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--preset=NAME` | Preset from `config/ndomo.config.json::presets[NAME]` | `default` |
| `--provider=ID` | Override provider prefix on preset models (e.g., `opencode`, `anthropic`) | (none) |
| `--no-provider-prompt` | Skip interactive provider override prompt | `false` |
| `--with-dcp` | Install `@tarquinen/opencode-dcp` (AGPL-3.0 peer) | `false` |
| `--dry-run` | Print planned changes, do not write | `false` |
| `--skip-deps` | Skip `bun install` step | `false` |
| `--uninstall` | Run uninstaller (compat shim to `scripts/uninstall.sh`) | `false` |
| `--help, -h` | Show help | `false` |

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `NDOMO_SKIP_PACKAGE_INSTALL=1` | Skip ndomo package installation entirely |
| `XDG_CONFIG_HOME` | Override config directory (default: `~/.config`) |

## Package Install Strategies

The installer attempts three strategies in order to register ndomo as a package in `~/.config/opencode/`:

1. **file: dep + bun install** -- Adds `"ndomo": "file://<project>"` to the config dir's `package.json`, runs `bun install`. Produces a real copy (no symlink). Preferred.
2. **bun link** -- Runs `bun link` in the project root, then `bun link ndomo` in the config dir. Produces a managed symlink. May cause Bun cache stale warnings.
3. **Manual symlink** -- Last resort. Creates a raw symlink from `node_modules/ndomo` to the project root.

Strategy 1 is preferred because it avoids symlink-related cache staleness. If you encounter stale cache warnings, run `bun run dev:bust` to clear the cache and force a real copy.

Set `NDOMO_SKIP_PACKAGE_INSTALL=1` to skip package installation entirely.

## Migration from Bash

One-liner mapping from `scripts/install.sh` to the new TS installer:

| Old (bash) | New (TS) |
|------------|----------|
| `curl -fsSL .../install.sh \| bash` | `bunx ndomo install` |
| `./install.sh --preset=budget` | `bunx ndomo install --preset=budget` |
| `./install.sh --provider=opencode` | `bunx ndomo install --provider=opencode` |
| `./install.sh --with-dcp` | `bunx ndomo install --with-dcp` |
| `./install.sh --no-provider-prompt` | `bunx ndomo install --no-provider-prompt` |
| `./install.sh --uninstall` | `bunx ndomo install --uninstall` |

The bash version is preserved for backward-compatibility (e.g., pipe-mode from raw GitHub URL) but is deprecated and will be removed in a future major version.

## Troubleshooting

### "bun is not installed"

Install bun first:

```bash
curl -fsSL https://bun.sh/install | bash
```

### "No agents/ directory found"

Run from a ndomo clone. The installer expects `agents/`, `skills/`, and `config/` directories at the project root.

### Symlink stale cache warning

Run `bun run dev:bust` to clear the Bun cache and reinstall ndomo as a real copy via the file: dep strategy (strategy 1).

### Package install strategy 2 (bun link) fails

The installer automatically falls back to strategy 3 (manual symlink). If you want to skip package installation entirely, set:

```bash
export NDOMO_SKIP_PACKAGE_INSTALL=1
bunx ndomo install
```

### Preset not found

The installer validates the preset name against `config/ndomo.config.json::presets` before proceeding. Check available presets:

```bash
grep -o '"[a-z]*":' config/ndomo.config.json | head -20
```

Default presets: `default`, `budget`.

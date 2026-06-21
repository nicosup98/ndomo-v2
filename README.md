# ndomo

OpenCode multi-agent plugin. Taller de artesanos: 19 specialists under one Foreman, one Craftsman, and one Warden. Caveman-native. opencode-mem integrated. DCP peer optional.

## What is ndomo

ndomo is a multi-agent orchestration plugin for [OpenCode](https://github.com/opencode-ai). It routes development tasks to 19 specialized agents (scout, scribe, painter, smith, sage, guild, stack-smiths, inspector, chronicler, and ops agents) coordinated by 3 primaries: Foreman (planning), Craftsman (implementation), Warden (operations). All agents use the Caveman output protocol for token-efficient communication. Memory persistence across sessions is handled by opencode-mem. The optional DCP plugin provides additional context pruning for long sessions.

## Agents

| Agent | Role | Model (default preset) | Type |
|---|---|---|---|
| **foreman** | Master orchestrator and scheduler | minimax/MiniMax-M3 | primary |
| **warden** | Ops custodian — CI/CD, deploy, releases, monitoring | opencode-go/deepseek-v4-flash | primary |
| **scout** | Codebase reconnaissance | opencode-go/minimax-m2.7 | subagent |
| **scribe** | External knowledge retrieval | opencode-go/minimax-m2.7 | subagent |
| **painter** | UI/UX design and visual composition | opencode-go/kimi-k2.6 | subagent |
| **smith** | Fast generic implementation | opencode-go/deepseek-v4-flash | subagent |
| **go-smith** | Go implementation specialist | xiaomi/mimo-v2.5-pro | subagent |
| **js-smith** | JS/TS implementation specialist | xiaomi/mimo-v2.5-pro | subagent |
| **python-smith** | Python implementation specialist | xiaomi/mimo-v2.5-pro | subagent |
| **vue-smith** | Vue 3 / Pinia implementation specialist | xiaomi/mimo-v2.5-pro | subagent |
| **zig-smith** | Zig 0.16 implementation specialist | xiaomi/mimo-v2.5-pro | subagent |
| **rust-smith** | Rust implementation specialist | opencode-go/mimo-v2.5-pro | subagent |
| **sage** | Architecture advisor and debugger | opencode-go/deepseek-v4-pro | subagent |
| **guild** | Multi-LLM consensus and debate | opencode-go/deepseek-v4-pro | subagent |
| **inspector** | Code quality and security auditor | opencode-go/deepseek-v4-pro | subagent |
| **chronicler** | Technical documentation writer | opencode-go/deepseek-v4-flash | subagent |
| **ci-smith** | CI/CD pipeline specialist | opencode-go/deepseek-v4-flash | subagent |
| **deploy-smith** | Deployment automation specialist | opencode-go/deepseek-v4-flash | subagent |
| **release-smith** | Release management specialist | opencode-go/deepseek-v4-flash | subagent |
| **ops-scout** | Infrastructure recon specialist (read-only) | opencode-go/deepseek-v4-flash | subagent |

**Groups:** Orchestrator (foreman), Explorers (scout, scribe), Builders (painter, smith, go-smith, js-smith, python-smith, vue-smith, zig-smith, rust-smith), Advisors (sage, guild), Quality (inspector, chronicler), Operations (warden, ci-smith, deploy-smith, release-smith, ops-scout).

## Quick Start

```bash
# Quick install (interactive, will prompt for provider)
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash

# Non-interactive with provider preset
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- --provider=opencode --no-provider-prompt

# With budget preset + DCP
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- --preset=budget --with-dcp
```

By default the install applies `presets.default` from `config/ndomo.config.json`. Use `--preset=budget` for cheaper models, `--provider=ID` to override the provider prefix.

Or from source:

```bash
git clone <repo-url> ndomo
cd ndomo
bun install
opencode
```

Inside OpenCode, verify all agents respond:

```
ping all agents
```

## Installation

**Prerequisites:** [bun](https://bun.sh) >= 1.1.0, OpenCode installed and configured with at least one authenticated provider.

Install via curl (recommended):

```bash
# Interactive install (will prompt for provider)
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash

# With provider preset (non-interactive)
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- --provider=opencode --no-provider-prompt

# With budget preset + DCP
curl -fsSL https://raw.githubusercontent.com/darrenhinde/OpenAgentsControl/main/install.sh | bash -s -- --preset=budget --with-dcp
```

Or from a local clone:

```bash
git clone <repo-url> ndomo
cd ndomo
./scripts/install.sh                 # with default preset
./scripts/install.sh --preset=budget # with budget models
./scripts/install.sh --with-dcp      # include DCP plugin
```

See [docs/installation.md](docs/installation.md) for detailed steps.

**Flags:**

| Flag | Description |
|---|---|
| `--provider=ID` | Override the provider prefix for all agents. The model ID is taken from the active preset; only the `provider/` segment of the `model:` field is swapped. Example: preset gives `opencode-go/minimax-m2.7`, `--provider=opencode` rewrites to `opencode/minimax-m2.7`. |
| `--no-provider-prompt` | Skip the interactive provider prompt. The preset is still applied; no provider prefix override is performed. |
| `--preset=NAME` | Select preset from `config/ndomo.config.json::presets[NAME]`. The preset is the source of truth for agent models at install time. (default: `default`, options: `default`, `budget`) |
| `--with-dcp` | Install and configure the DCP plugin. |
| `--repo=URL` | Override repository URL (for piped installs from a fork). |
| `--branch=NAME` | Override repository branch (for piped installs from dev branches). |

**Uninstall:** `./scripts/uninstall.sh [--keep-data]`

## Plans & Tasks DB

ndomo persists plans, tasks, and sessions in a project-local SQLite database
(`<project>/.ndomo/state.db`) with FTS5 search, audit trail, and auto-archive
to markdown on completion. 14 tools exposed via OpenCode: `plan_create`,
`plan_get`, `plan_list`, `plan_search`, `plan_approve`, `plan_update_status`,
`task_create_batch`, `task_list`, `task_update_status`, `task_search`,
`task_next_for_agent`, `session_start`, `session_checkpoint`, `session_end`.

The foreman uses these to track work across agent dispatches. See
[docs/database.md](docs/database.md) for schema, tools, lifecycle, and
auto-archive behavior.

## Configuration

Config file: `~/.config/opencode/ndomo.json`

```json
{
  "preset": "default",
  "caveman": { "intensity": "full", "autoClarity": true },
  "mem": {
    "storagePath": "~/.ndomo/mem",
    "defaultScope": "project",
    "autoCaptureEnabled": true,
    "cavemanCompress": true
  }
}
```

See [docs/configuration.md](docs/configuration.md) for full reference. Agent presets support an optional `reasoning_effort` field (`low`/`medium`/`high`/`xhigh`) for reasoning-capable models.

## Skills

ndomo bundles 7 skills under `skills/`:

| Skill | Description |
|---|---|
| `caveman` | Ultra-compressed communication mode (~75% token reduction) |
| `cavecrew` | Caveman-style subagent presets (investigator, builder, reviewer) |
| `deepwork` | Structured heavy coding with plan files and review gates |
| `reflect` | Workflow friction analysis and reusable pattern extraction |
| `worktrees` | Git worktree management for isolated coding lanes |
| `dcp-integration` | Dynamic Context Pruning integration guide |
| `mem-recall` | opencode-mem tool usage and memory retrieval patterns |

## Integrations

- **opencode-mem** (required) — persistent memory with SQLite + USearch vector DB. Web UI at `:4747`. All agents compress memories before storage using caveman regex compression (0 LLM tokens).
- **DCP** (optional) — `@tarquinen/opencode-dcp` for dynamic context pruning. AGPL-3.0. Installed with `--with-dcp` flag.

See [docs/integrations.md](docs/integrations.md) for details.

## Token Savings

The Caveman output protocol reduces token usage by ~60-75% vs standard prose by stripping articles, filler words, conjunctions, and pleasantries while preserving all technical content. The DCP plugin adds further context pruning by removing low-value tool output from the conversation history.

## License

MIT

## Links

- Repository: [https://github.com/nicosup98/ndomo-v2](https://github.com/nicosup98/ndomo-v2)
- OpenCode: [https://github.com/opencode-ai](https://github.com/opencode-ai)
- opencode-mem: [https://github.com/opencode-ai/opencode-mem](https://github.com/opencode-ai/opencode-mem)

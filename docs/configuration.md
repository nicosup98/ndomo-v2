# Configuration Reference

## Config File Location

`~/.config/opencode/ndomo.json`

The schema is defined in `config/ndomo.schema.json` (JSON Schema draft-07) for editor validation.

## Presets

Two built-in presets control which models each agent uses.

### default

| Agent | Model | Temperature |
|---|---|---|
| foreman | minimax/MiniMax-M3 | 0.3 |
| scout | opencode-go/minimax-m2.7 | 0.3 |
| scribe | opencode-go/minimax-m2.7 | 0.3 |
| painter | opencode-go/kimi-k2.6 | 0.2 |
| smith | opencode-go/deepseek-v4-flash | 0.1 |
| sage | opencode-go/deepseek-v4-pro | 0.2 |
| guild | opencode-go/deepseek-v4-pro | 0.3 |
| go-smith | xiaomi/mimo-v2.5-pro | 0.1 |
| js-smith | xiaomi/mimo-v2.5-pro | 0.1 |
| python-smith | xiaomi/mimo-v2.5-pro | 0.1 |
| vue-smith | xiaomi/mimo-v2.5-pro | 0.1 |
| zig-smith | xiaomi/mimo-v2.5-pro | 0.1 |
| chronicler | opencode-go/deepseek-v4-flash | 0.2 |
| inspector | opencode-go/deepseek-v4-pro | 0.2 |

### budget

All agents use `opencode-go/deepseek-v4-flash` at their respective temperatures. Reduces API costs at the expense of specialist model quality for stack-smiths and advisors.

## Provider Selection at Install Time

The `install.sh` script includes a provider picker that modifies agent models before registration. This is not a runtime setting — it applies once during installation and is baked into each agent's frontmatter.

### How it works

1. When run without `--provider` and without `--no-provider-prompt`, the script fetches `https://models.dev/catalog.json` and caches it at `~/.cache/ndomo/models-catalog.json`.
2. The top 20 providers are displayed as an interactive numbered list.
3. You select a provider by entering its number or ID.
4. The selected provider replaces the provider prefix in every agent's `model:` field in `agents/*.md`.

### Example transformation

If you select provider `opencode-go`, the agent models transform as follows:

| Original | After provider selection |
|---|---|
| `minimax/MiniMax-M3` | `opencode-go/MiniMax-M3` |
| `opencode-go/deepseek-v4-flash` | `opencode-go/deepseek-v4-flash` (unchanged) |
| `xiaomi/mimo-v2.5-pro` | `opencode-go/mimo-v2.5-pro` |

### Flags controlling provider selection

| Flag | Behavior |
|---|---|
| `--provider=ID` | Non-interactive provider selection. Skips the catalog fetch and picker. |
| `--no-provider-prompt` | Skips the interactive picker entirely. Each agent keeps its original `model:` value. |

### Relevant files modified

- `agents/*.md` — the `model:` field in each agent's frontmatter is sed-replaced during Step 5.5 of the install script.
- `~/.cache/ndomo/models-catalog.json` — cached catalog (re-fetched weekly or on cache miss).

The provider selection is a one-time install operation. To change providers after installation, either re-run `install.sh` with a different `--provider` flag, or manually edit the `model:` fields in `agents/*.md`.

## Agent Routing

The `agentRouting` field defines the delegation graph. Only the `foreman` agent is defined as `mode: "primary"` — all other agents are subagents. The foreman's `delegates_to` array lists all 13 subagents.

Routing decisions are made by the scheduler (`src/orchestrator/scheduler.ts`):

| Task type | Stack | Risk | Routed to |
|---|---|---|---|
| explore | any | any | scout |
| research | any | any | scribe |
| design | vue | any | painter |
| audit | any | any | inspector |
| document | any | any | chronicler |
| debate | any | any | guild |
| debug | any | high | sage |
| implement | go | any | go-smith |
| implement | vue | any | vue-smith |
| implement | js | any | js-smith |
| implement | python | any | python-smith |
| implement | zig | any | zig-smith |
| implement | generic/unknown | any | smith |
| implement | known stack | high | stack-smith + sage advisory |
| any other | any | any | smith (fallback) |

## Caveman Settings

```json
{
  "caveman": {
    "intensity": "full",
    "autoClarity": true
  }
}
```

| Field | Type | Values | Description |
|---|---|---|---|
| `intensity` | string | `lite`, `full`, `ultra` | Compression level. `lite` keeps some articles; `full` strips all fillers; `ultra` maximum compression. |
| `autoClarity` | boolean | `true`, `false` | When `true`, agents switch to full verbosity for safety warnings, irreversible actions, or multi-step ambiguity, then resume caveman. |

## DCP Overrides

Per-agent context limits for the DCP plugin. Only takes effect when `@tarquinen/opencode-dcp` is installed.

```json
{
  "dcp_overrides": {
    "scout": { "minContextLimit": 30000, "maxContextLimit": 80000 },
    "scribe": { "minContextLimit": 30000, "maxContextLimit": 80000 },
    "foreman": { "minContextLimit": 50000, "maxContextLimit": 100000 },
    "sage": { "minContextLimit": 50000, "maxContextLimit": 100000 },
    "guild": { "minContextLimit": 50000, "maxContextLimit": 100000 },
    "inspector": { "minContextLimit": 40000, "maxContextLimit": 90000 }
  }
}
```

Agents without explicit overrides use DCP defaults. The foreman monitors context size and triggers compression when approaching `maxContextLimit`.

## Memory Config

```json
{
  "mem": {
    "storagePath": "~/.ndomo/mem",
    "defaultScope": "project",
    "autoCaptureEnabled": true,
    "cavemanCompress": true
  }
}
```

| Field | Type | Description |
|---|---|---|
| `storagePath` | string | Directory for memory storage. Supports `~` expansion. |
| `defaultScope` | string | `"project"` — search only current project memories; `"all-projects"` — search across all projects. |
| `autoCaptureEnabled` | boolean | Automatically capture insights during sessions without explicit `memory({mode:"add"})` calls. |
| `cavemanCompress` | boolean | Apply caveman regex compression to memories before storage. Saves tokens on retrieval. |

## Protected Tools

Tools listed in `protectedTools` cannot be disabled, overridden, or pruned from context by any subagent:

```json
"protectedTools": ["memory", "compress", "task", "todowrite", "skill"]
```

| Tool | Why Protected |
|---|---|
| `memory` | Required for cross-session persistence and context retrieval |
| `compress` | Required for DCP context pruning when near token limits |
| `task` | Required for subagent delegation and background dispatch |
| `todowrite` | Required for structured task tracking |
| `skill` | Required for loading agent skill definitions |

## Custom Agents

To add a custom agent to the routing table:

1. Create an agent definition file in `agents/<name>.md` with frontmatter:
   ```yaml
   ---
   description: My custom agent
   mode: subagent
   model: provider/model-id
   temperature: 0.1
   permission:
     edit: allow
     bash: allow
     question: allow
   ---
   ```

2. Add the agent to the foreman's `delegates_to` array in `config/ndomo.config.json`.

3. Add a routing rule in `src/orchestrator/scheduler.ts` or rely on the Foreman prompt routing table.

4. Optionally add a model entry in the `default` and `budget` presets.

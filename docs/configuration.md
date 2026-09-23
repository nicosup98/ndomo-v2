# Configuration Reference

## Config File Location

`~/.config/opencode/ndomo.json`

The schema is defined in `config/ndomo.schema.json` (JSON Schema draft-07) for editor validation.

## Presets

These presets are the source of truth for agent models at install time. The installer rewrites each agent's `model:` and `temperature:` from the active preset on every install.

Two built-in presets control which models each agent uses.

### Per-agent fields

Each agent entry in a preset supports three fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | yes | Model identifier in `provider/model-id` format |
| `temperature` | number (0-1) | yes | Sampling temperature (0 = deterministic, 1 = creative) |
| `reasoning_effort` | enum: `low`/`medium`/`high`/`xhigh` | no | Reasoning effort level for reasoning-capable models (DeepSeek, MiMo, OpenAI). Translated to camelCase `reasoningEffort:` in agent `.md` frontmatter. Omit for non-reasoning models. |

Example:
```json
{
  "presets": {
    "default": {
      "smith": {
        "model": "opencode-go/deepseek-v4-flash",
        "temperature": 0.1,
        "reasoning_effort": "medium"
      }
    }
  }
}
```

### default

| Agent | Model | Temperature |
|---|---|---|
| foreman | minimax/MiniMax-M3 | 0.3 |
| scout | opencode-go/minimax-m2.7 | 0.3 |
| scribe | opencode-go/minimax-m2.7 | 0.3 |
| painter | opencode-go/kimi-k2.6 | 0.2 |
| smith | opencode-go/deepseek-v4-flash | 0.1 |
| ranger | minimax/MiniMax-M3 | 0.3 |
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

## Provider Override at Install Time

The installer includes a provider override that modifies agent models before registration. This is not a runtime setting — it applies once during installation and is baked into each agent's frontmatter.

The preset (not the provider) defines the model ID. `--provider=ID` only changes the `provider/` prefix in each agent's `model:` field, so the literal `default` model ID is never used.

### How it works

1. Without `--provider` and without `--no-provider-prompt`, the script shows the active preset and asks for confirmation.
2. Selecting `override` enters the interactive provider picker from models.dev.
3. The selected provider prefix replaces the existing `provider/` segment in every agent's `model:` field in `agents/*.md`.

### Example transformation

If you override with provider `opencode`, the agent models transform as follows:

| Original | After provider prefix override |
|---|---|
| `minimax/MiniMax-M3` | `opencode/MiniMax-M3` (provider prefix changed) |
| `opencode-go/deepseek-v4-flash` | `opencode/deepseek-v4-flash` (provider prefix changed) |
| `xiaomi/mimo-v2.5-pro` | `opencode/mimo-v2.5-pro` (provider prefix changed) |

### Flags controlling provider override

| Flag | Behavior |
|---|---|
| `--provider=ID` | Non-interactive provider prefix override. The model ID is taken from the active preset; only the `provider/` segment of the `model:` field is swapped. |
| `--no-provider-prompt` | Skips the interactive picker. The preset is still applied; no prefix override is performed. |

The install also wires the plugin into the OpenCode config directory (`~/.config/opencode/`) so tools are auto-registered on OpenCode launch — see [OpenCode v2 plugin docs](https://opencode.ai/v2/docs/build/plugins). Registration uses the v2 `plugins` key (array of `string | { package, options }`); the installer migrates any legacy v1 `plugin` key it finds.

### Relevant files modified

- `agents/*.md` — the `model:` field in each agent's frontmatter is modified during Step 5.5 of the install script.
- `~/.cache/ndomo/models-catalog.json` — cached catalog (re-fetched weekly or on cache miss).

The provider override is a one-time install operation. To change providers after installation, either re-run `bunx ndomo install` with a different `--provider` flag, or manually edit the `model:` fields in `agents/*.md`.

## Hot-swap: editing models without re-running install

`ndomo.json::presets[preset][agent].model` is the **runtime source of truth** for agent models. The plugin's `syncAgentFrontmatter()` runs at every OpenCode session startup, compares each agent's `model:` and `temperature:` in `~/.config/opencode/agent/<agent>.md` against the active preset in `ndomo.json`, and rewrites the file when the values differ. This means you can edit `ndomo.json` directly and have the changes take effect on the next session — no need to re-run the installer.

**Workflow:**

1. Open `~/.config/opencode/ndomo.json`.
2. Edit `presets[default|...][<agent-name>].model` and/or `.temperature`. Example:

   ```json
   {
     "preset": "default",
     "presets": {
       "default": {
         "foreman": { "model": "anthropic/claude-sonnet-4.5", "temperature": 0.3 }
       }
     }
   }
   ```

3. Restart OpenCode. The plugin logs `[ndomo] frontmatter sync: preset=default synced=N skipped=M errors=0` on startup.

**Notes:**

- Only agents present in the active preset are synced. User-added custom agents (not in `ndomo.json`) are left untouched.
- The function is **idempotent** — running it with an unchanged config is a no-op (`skipped=N, synced=0`).
- To disable hot-swap (e.g., for read-only configs or CI), set env var `NDOMO_SKIP_FRONTMATTER_SYNC=1` before launching OpenCode.
- If the active preset is missing from `ndomo.json` (e.g., `"preset": "production"` but only `default` and `budget` are defined), sync is skipped with a warning — agent files keep their current values.
- `reasoning_effort` syncing supports both updating an existing `reasoningEffort:` line and inserting a new one (placed after `temperature:`, then `model:`, then `---` as fallback).

## Agent Routing

The `agentRouting` field defines the delegation graph. Four agents are defined as `mode: "primary"` peer primaries: `foreman` (planner/orchestrator), `craftsman` (implementer), `warden` (ops custodian), and `ranger` (analyst/cartographer/onboarding). All other agents are subagents reachable via the primaries' `delegates_to` arrays. The foreman's `delegates_to` array lists all subagents it can dispatch.

**Ranger** is the 4th primary, registered separately with `mode: "primary"` and its own delegation graph (`scout`, `sage`, `scribe`). Unlike foreman/craftsman/warden, ranger does not create plans — it produces rows in the `analyses` DB table linkable retroactively via `analysis_link_plan`.

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

## JEV Configuration

JEV (TypeSafe AI) is the optional LLM classifier behind four advisory MCP tools: `classify_intent`, `classify_tests`, `code_traffic_light`, and `validate_task_dependencies`. All four are deterministic-first, never throw, and return a deterministic fallback when JEV is unavailable — JEV only refines ambiguous classification.

```json
{
  "jev": {
    "enabled": true,
    "model": "jev-latest",
    "timeoutMs": 3000
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. `false` forces the deterministic path for all four tools. |
| `model` | string | `"jev-latest"` | TypeSafe model identifier used for classification. |
| `timeoutMs` | number | `3000` | Per-request timeout (AbortSignal). |

The API key is **not** part of this config: it is read from the `TYPESAFE_API_KEY` environment variable only (see `src/orchestrator/jev.ts`). Without the key, JEV is a silent no-op and every tool falls back to deterministic rules — all four tools keep working identically, just without LLM refinement (`source` reports `"parser"`/`"rules"`/`"fallback"` instead of `"jev"`).

### Tool usage examples

- `classify_intent({prompt: "fix the broken login redirect"})` → `{intent: "bugfix", flow: "plan", warnings: []}` (or `null` when JEV is disabled/unavailable).
- `classify_tests({output: "<bun output>", runner: "bun"})` → `{verdict: "green", source: "parser", runner: "bun", results: [...], counts: {total, pass, fail, skip, unresolved}, warnings: [...]}`.
- `code_traffic_light({diff: "<unified diff>"})` → `{light: "red", source: "rules", findings: [{patternId, category, severity, file, line, snippet, description}], maxSeverity, truncated, warnings}`.
- `validate_task_dependencies({planId: "<uuid>", apply: true})` → `{source: "rules"|"jev"|"hybrid", pairs, edges, waves, dropped, suggestions, truncated, warnings, applied}` — `apply: true` merges suggested dependencies into `pending` tasks only.

### Caps

- `classify_tests`: raw output truncated to the last 64 KiB, `expectedTests` capped at the first 50, JEV test questions capped at 20.
- `code_traffic_light`: diff capped at 100 KiB (head-truncated).
- `validate_task_dependencies`: max 8 tasks / 28 pairs per call.

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
    "inspector": { "minContextLimit": 40000, "maxContextLimit": 90000 },
    "ranger": { "minContextLimit": 50000, "maxContextLimit": 100000 }
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
| `storagePath` | string | Storage root for ndomo embedded memory. One SQLite DB per project at `<storagePath>/projects/<projectTag>.db`. Supports `~` expansion. Overridable via `NDOMO_MEM_STORAGE_PATH` (used by tests/CI). Does NOT control plan archive location. |
| `defaultScope` | string | `"project"` — search only current project memories; `"all-projects"` — search across all projects. |
| `autoCaptureEnabled` | boolean | Automatically capture insights during sessions without explicit `mem_add` calls. |
| `cavemanCompress` | boolean | Apply caveman regex compression to memories before storage (`memory_compress`). Saves tokens on retrieval. |

### mem_* tools

| Tool | Args | Returns | Purpose |
|---|---|---|---|
| `mem_add` | `content` (required), `type?`, `tags?` (string[]), `pinned?` | `{id, deduplicated, projectTag}` | Store a memory. Exact dedup via `content_hash` — re-adding the same text returns the existing id |
| `mem_search` | `query` (required), `scope?` (`"project"`/`"all-projects"`), `type?`, `tag?`, `limit?` (default 10) | `{results: [{id, content, type, tags, projectTag, createdAt, score, excerpt}], count, scope}` | FlexSearch-ranked full-text search |
| `mem_list` | `scope?`, `type?`, `tag?`, `limit?` (default 20), `offset?` (default 0) | `{memories, total, scope}` | List memories, pinned first then newest |
| `mem_forget` | `id` | `{id, removed}` | Delete a memory by id |
| `mem_stats` | `scope?` | `{stats: {total, byType, byTag, pinned, oldest, newest}, scope}` | Aggregate statistics |
| `memory_compress` | `text` | `{original, compressed, result}` | Compress arbitrary text to caveman format (regex, 0 LLM tokens) |

> **Note:** `~/.ndomo/mem/` is ndomo's **embedded memory** store (bun:sqlite +
> FlexSearch — one SQLite DB per project under `projects/`, WAL mode, see
> [docs/database.md](docs/database.md#embedded-memory-store-ndomomem)). The
> **ndomo orchestration** database is at `<project>/.ndomo/state.db` (SQLite) —
> see [docs/database.md](docs/database.md). These are two separate stores: the
> memory store is user-global (shared across projects when `scope: "all-projects"`),
> `state.db` is project-local.
>
> **Plan archive path:** The ndomo plugin auto-archives completed/failed plans
> to `<project>/.ndomo/archives/plans/<slug>-YYYY-MM-DD.md` (markdown snapshots).
> This path is **not configurable** via `ndomo.json` — it always lives under
> `<project>/.ndomo/archives/plans/`. See [docs/database.md#auto-archive](docs/database.md#auto-archive).

## Protected Tools

Tools listed in `protectedTools` cannot be disabled, overridden, or pruned from context by any subagent:

```json
"protectedTools": ["mem_search", "compress", "task", "todowrite", "skill"]
```

| Tool | Why Protected |
|---|---|
| `mem_search` | Required for cross-session persistence and context retrieval |
| `compress` | Required for DCP context pruning when near token limits |
| `task` | Required for subagent delegation and background dispatch |
| `todowrite` | Required for structured task tracking |
| `skill` | Required for loading agent skill definitions |

## Troubleshooting

### Tools not registered / DB not created

The ndomo package is not in `~/.config/opencode/node_modules/ndomo/`. OpenCode's plugin loader silently skips plugins it cannot resolve, so no tools, DB, or agents will appear.

**Fix:** Re-run `bunx ndomo install` or symlink it manually:

```bash
ln -sfn $(pwd) ~/.config/opencode/node_modules/ndomo
```

Then ensure `ndomo` is listed in `opencode.json` under `plugins`. See [plugin docs](https://opencode.ai/docs/es/plugins/) for details.

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

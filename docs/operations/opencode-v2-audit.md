# OpenCode v2 Migration Audit — ndomo (v1→v2 touchpoint inventory)

- **Date:** 2026-09-21
- **Author:** ranger (Sensory Analyst / Cartographer)
- **Mode:** sensory-analyst + cartographer (pre-migration audit, Plan A task 0)
- **Plan:** `opencode-v2-migration` — `cde53800-a233-4448-b6af-33e87235e3d6` (approved, priority 1)
- **Design ref:** `docs/designs/2026-09-21-opencode-v2-jev-routing-design.md` (foreman, approved — clean break v2 chosen)
- **Sources:** official v2 docs `/build/plugins`, `/build/plugins/migrate-v1`, `/build/client` (fetched 2026-09-21)

> Ranger output is **observation-only**. No implementation decisions are made here — only inventory, API mapping,
> risk classification, gap documentation, and answers to the design doc's open questions. Craftsman/warden execute.

---

## 1. Objective & scope

Inventory every v1 OpenCode plugin touchpoint in the ndomo repo, map each to the v2 API per the official
migration guide, document gaps with no v2 equivalent, research the v2 client package + install mechanics, and
resolve the dual-support-vs-clean-break question. Scope: the entire ecosystem (`src/plugin.ts`, `tools/*.ts`,
`src/sdk/client.ts`, `src/cli/*`, `src/http/*`, `web/*`, `opencode.json`, `scripts/install.sh`, `config/*`).

---

## 2. Primary findings (summary)

- **Package rename is the spine of the migration:** `@opencode-ai/plugin` → `@opencode/plugin` (import `Plugin.define`),
  and `@opencode-ai/sdk` → `@opencode/client` (out-of-process) — or eliminate the SDK client entirely inside the plugin
  via `ctx.event.subscribe()`.
- **Entrypoint shape changes completely:** v1 `export const P: Plugin = async (input) => ({ hooks, tool })` →
  v2 `export default Plugin.define({ id, async setup(ctx){...} })` + optional cleanup function.
- **Hooks become domain-registered, single-event callbacks:** v1 string-keyed hook map with `(input, output)` pairs →
  v2 `ctx.<domain>.hook("name", (event) => {...})` with one mutable `event`.
- **Tools become transform-registered:** v1 `tool()` helper + `tool` map → v2 `ctx.tool.transform(editor => editor.add({...}))`
  with JSON-Schema `input` and `{ content }` return shape. The 27 standalone `tools/*.ts` files (v1 `tool()` API) have
  **no v2 `tools/` directory mechanism** and must be consolidated into the `setup` transform.
- **Three real behavioral gaps** affect ndomo (beyond the 3 named-but-unused experimental hooks): (a) compaction
  context-injection, (b) tool-execute `ctx.sessionID`/`agent`/`messageID` availability, (c) SDK client package + HTTP bridge.
- **Install flow:** `plugin` key → `plugins` (string | `{package, options}`); `file://` dep strategy stays valid;
  `stepCopyTools` / `install_custom_tools_symlink` become dead code.
- **Decision:** clean break v2 (no dual-support). Current deps are v1 (`@opencode-ai/plugin`/`@opencode-ai/sdk` 1.17.7);
  no active 1.x install requires continued support.

---

## 3. Touchpoint → v2 API → risk → phase table

Phase legend: **T1** = `src/plugin.ts` core (craftsman task 1) · **T2** = tools/*.ts + sdk/client + cli + config + install (task 2) ·
**T3** = web/ + http/ (task 3) · **T4** = deps/CI/Docker/smoke + e2e verify (warden task 4).

### 3.1 Plugin entrypoint & context (`src/plugin.ts`)

| Touchpoint | V1 API | V2 API | Risk | Phase |
|---|---|---|---|---|
| `src/plugin.ts:17-18` import | `import { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"; import { tool }` | `import { Plugin } from "@opencode/plugin"` (no `tool`, `Hooks`, `PluginInput`) | HIGH | T1 |
| `src/plugin.ts:533` entry | `export const NdomoPlugin: Plugin = async (input, options) => {...; return { hooks, tool }}` | `export default Plugin.define({ id: "ndomo", async setup(ctx) {...; return cleanup } })` | HIGH | T1 |
| `input.directory` (plugin.ts:537) | `input.directory` | `ctx.location.directory` | LOW | T1 |
| `input.worktree` (plugin.ts:537) | `input.worktree` | `ctx.location.project` (`{id, directory, canonical}`) — plugin's own location, not session's | MED | T1 |
| `input.sessionID`/`messageID`/`agent`/`callID` in hooks | on hook `(input, output)` | on hook `event` (confirm exact fields; see §4 G-tool-ctx) | MED | T1 |
| `client` (SDK v1, plugin.ts:571) | `@opencode-ai/sdk` client | in-plugin: `ctx` domains; out-of-process: `@opencode/client` | HIGH | T1/T2 |
| `options` arg (plugin.ts:535) | 2nd arg to plugin fn | `ctx.options` | LOW | T1 |
| cleanup / `dispose()` | returned `dispose()` from hook map | cleanup fn returned by `setup` | LOW | T1 |
| `event` subscription (none in v1 plugin) | — | `ctx.event.subscribe({ signal })` + abort in cleanup | LOW | T1 |

### 3.2 Hooks (`src/plugin.ts`)

| Touchpoint | V1 API | V2 API | Risk | Phase |
|---|---|---|---|---|
| `src/plugin.ts:666` `experimental.session.compacting` | `(input, output) => output.context.push(...)` injects orchestrator state into compaction prompt | `ctx.session.hook("compaction", (event) => { event.result = {summary}; /* OR edit event.messages */ })` | **HIGH** (no `output.context.push` analog — see §4 G-ap) | T1 |
| `src/plugin.ts:735` `tool.execute.before` | `(input, output)`; uses `input.sessionID`, `input.tool`, `output.args`, `input.callID` (circuit breaker + file lock) | `ctx.tool.hook("execute.before", (event) => {...})` — `event.tool`, `event.input` | MED (confirm `sessionID`/`callID` on event) | T1 |
| `src/plugin.ts:788` `tool.execute.after` | `(input)`; uses `input.tool`, `input.args`, `input.sessionID` | `ctx.tool.hook("execute.after", (event) => {...})` | MED | T1 |
| `src/plugin.ts:806` `shell.env` | `(_input, output) => output.env.NDOMO_PRESET = ...` | `ctx.shell.hook("create.before", (event) => { event.env.NDOMO_PRESET = ... })` | LOW (renamed + env on event) | T1 |
| `src/plugin.ts:801-804` `file.edited` | commented out — NOT in v1 SDK | N/A (unused) | NONE | — |

### 3.3 Tools — inline in `src/plugin.ts` (46 tool definitions)

All 46 inline tools (plugin.ts:813–1866) use `tool({ description, args: {tool.schema.*}, execute })` and return
`JSON.stringify(...)`. Each maps to `ctx.tool.transform(editor => editor.add({ name, description, input: JSONSchema, options:{namespace, codemode}, async execute(input){ return { content } } }))`.

| Group | Tools (plugin.ts) | V2 transform target | Risk | Phase |
|---|---|---|---|---|
| Routing | `route`, `can_parallel` | `editor.add` w/ JSON Schema | LOW | T1 |
| Background | `dispatch`, `active_tasks`, `background_task_status`, `background_task_cancel` | same (BackgroundDispatcher is Bun-internal, survives) | LOW | T1 |
| Worktrees | `worktree_create/list/remove/verify` | same; `ctx.location` for dir | MED | T1 |
| Memory | `memory_search`, `memory_compress` | same | LOW | T1 |
| Ops/util | `ndomo_write_unlock`, `status` | same | LOW | T1 |
| Plans | `plan_create/get/list/search/approve/delete/update_status/progress/files_write` | same; **uses `ctx.agent`/`ctx.sessionID` — see G-tool-ctx** | HIGH | T1 |
| Tasks | `task_create_batch/list/update_status/verify/search/next_for_agent/dependency_resolver/peek_for_agent/add_artifact/review` | same; **uses `ctx.agent`/`ctx.sessionID`/`ctx.messageID`** | HIGH | T1 |
| Ops (warden) | `incident_create`, `rollback_record`, `task_escalate` | same; uses `ctx.agent` | MED | T1 |
| Analyses | `analysis_create/get/list/search/update/archive/link_plan` | same; uses `ctx.agent` + `validateAnalysisFindings` (ranger boundary) | MED | T1 |
| Sessions | `session_start/checkpoint/end` | same; uses `ctx.agent`/`ctx.sessionID`/`ctx.messageID` | HIGH | T1 |

**Two cross-cutting tool risks (apply to every inline tool):**
1. **Return shape:** v1 `execute` returns a `string` (usually `JSON.stringify`); v2 expects `{ content: ... }`
   (structured content). Mechanical but touches all 46. → HIGH surface.
2. **`tool.schema.*` → JSON Schema:** `tool.schema.string/enum/array/record/number/boolean/optional/int/min/max`
   must be rewritten as `input: { type:"object", properties, required, additionalProperties:false }`. Mechanical. → MED.

### 3.4 Tools — standalone `tools/*.ts` (27 files, T2)

Each `tools/*.ts` does `export default tool({...})` and opens its own DB (`openDb` + `runMigrations`). Files:
`analysis_archive, analysis_create, analysis_get, analysis_link_plan, analysis_list, analysis_search, analysis_update,
critic_review, design_create, ledger_create, ledger_get, ledger_update, plan_approve, plan_create, plan_get, plan_list,
plan_search, plan_update_status, session_checkpoint, session_end, session_start, task_create_batch, task_list,
task_next_for_agent, task_search, task_update_status, task_verify`.

| Touchpoint | V1 API | V2 API | Risk | Phase |
|---|---|---|---|---|
| All 27 `tools/*.ts` | `export default tool({...})` (v1 `tool()` helper) loaded from `~/.config/opencode/tools/` | **No v2 `tools/` directory mechanism documented.** Consolidate all 27 into the plugin `setup` `ctx.tool.transform` (merge with the 46 inline — many overlap, e.g. `plan_create` exists in both). Delete `tools/*.ts`. | **HIGH** | T2 |
| `stepCopyTools` (install.ts:800-851) | copies `tools/*.ts` → configDir/tools | REMOVE (obsolete in v2) | MED | T2 |
| `install_custom_tools_symlink` (install.sh:337-362) | symlinks `tools/` → configDir/tools | REMOVE | MED | T2 |

### 3.5 SDK client (`src/sdk/client.ts`, T2)

| Touchpoint | V1 API | V2 API | Risk | Phase |
|---|---|---|---|---|
| `src/sdk/client.ts:12` import | `createOpencodeClient` from `@opencode-ai/sdk/client` | `@opencode/client` → `OpenCode.make({ baseUrl, headers })`; events `client.event.subscribe()` | HIGH (package rename) | T2 |
| `src/sdk/client.ts` `getSdkClient` (plugin.ts:571-583 uses it for HTTP `/api/events`) | out-of-process SDK client | **In-plugin alternative:** `ctx.event.subscribe({ signal })` — no SDK client needed for the plugin's own event forwarding; bridge to HTTP SSE inside `setup`. Keep `@opencode/client` only for standalone `src/cli/serve.ts`. | MED (architectural) | T2/T3 |
| `src/http/server.ts:16`, `src/http/routes/events.ts:29` | `import type { OpencodeClient } from "@opencode-ai/sdk/client"` | `@opencode/client` (`OpenCode.make`) OR consume events bridged from `ctx.event` | MED | T3 |
| Node service discovery | — | `@opencode/client/service` → `Service.ensure({ version: v => v.startsWith("2.") })` for install/HTTP bootstrap | LOW | T2/T4 |

### 3.6 Install flow (`src/cli/install.ts`, `scripts/install.sh`, T2/T4)

| Touchpoint | V1 API | V2 API | Risk | Phase |
|---|---|---|---|---|
| `stepRegisterPlugins` (install.ts:571-631); install.sh:613-655 | writes `opencode.json` `"plugin": [...]` | writes `"plugins": [...]` (string \| `{package, options}`) | MED | T2 |
| `opencode.json` repo (root, line 1-7) | `"plugin": ["ndomo"]` | `"plugins": ["ndomo"]` | LOW | T2 |
| `stepInstallPackage` (install.ts:633-798); install.sh:657-658 | `file://<root>` + `bun install` → real copy in node_modules | **Still valid** — `file:///abs/path/ndomo` is a supported v2 plugin entry | LOW | T2 |
| `stepCopyTools` / `install_custom_tools_symlink` | copy/symlink `tools/*.ts` | REMOVE (no tools/ dir in v2) | MED | T2 |
| `ndomo.config.json` `plugins:["ndomo","opencode-mem"]` | ndomo-internal config (consumed by `loadNdomoConfig`), NOT opencode.json | unchanged — but `opencode-mem` is a **separate v1 plugin** that itself needs v2 migration (external dep; blocker for full function, out of ndomo scope) | MED (external) | T4 |

### 3.7 Config / CLI / web (T2/T3)

| Touchpoint | V1 API | V2 API | Risk | Phase |
|---|---|---|---|---|
| `config/ndomo.config.json`, `config/ndomo.schema.json` | ndomo-internal; `plugins`/`optionalPlugins` are ndomo's own registry | unchanged (downstream effect: installer writes `plugins` key) | LOW | T2 |
| `src/cli/*` (plan.ts, task.ts, status.ts, smoke.ts, vacuum.ts, index.ts) | DB/CLI only; **no `@opencode-ai/*` import** (grep-confirmed) | unchanged | LOW | T2 |
| `src/cli/serve.ts` | starts `http/server` (uses sdk via http) | unchanged entrypoint; depends on http/server v2 update | LOW | T3 |
| `web/*` (Vue SPA) | **no `@opencode-ai/*` import** (grep-confirmed) — calls ndomo HTTP API via `fetch` | unchanged; only indirect risk if HTTP API contract changes | LOW | T3 |

---

## 4. Gaps with no v2 equivalent (documented)

### 4.1 Named experimental hooks (NOT used by ndomo → low real impact)

Per `/build/plugins/migrate-v1`, these have no direct v2 equivalent. ndomo does **not** use any of them:

| Gap | Used by ndomo? | Impact |
|---|---|---|
| `experimental.compaction.autocontinue` | No | NONE |
| `experimental.provider.small_model` | No | NONE |
| `experimental.text.complete` | No (`memory_compress` uses caveman, not SDK) | NONE |

### 4.2 Real behavioral gaps (DO affect ndomo)

- **G-ap — Compaction context injection (HIGH).** v1 `experimental.session.compacting` pushed extra lines into
  `output.context` (orchestrator state: active tasks, active writes, active plans, recent sessions). v2 `ctx.session.hook("compaction")`
  exposes `event.messages` (transcript) and `event.result` (set to skip the model call); there is **no `output.context.push` analog**.
  Options for craftsman: (a) set `event.result.summary` to a fully-built summary that includes the orchestrator state
  (replaces model-generated summary), or (b) prepend the orchestrator state into `event.messages` before the summary prompt.
  This changes auto-checkpoint context behavior and must be decided explicitly.
- **G-tool-ctx — Tool-execute `ctx.sessionID` / `agent` / `messageID` (HIGH, must confirm).** v1 tool `execute(args, ctx)`
  exposed `ctx.sessionID`, `ctx.agent`, `ctx.messageID`, `ctx.directory`, `ctx.worktree`, `ctx.callID`. ndomo embeds these
  into DB rows in ~15 tools (`plan_create`, `plan_update_status`, `task_update_status`, `analysis_create/update`,
  `session_start/end/checkpoint`, `task_escalate`, `incident_create`, `rollback_record`, `escalateToForeman`). v2 tool
  `execute(input, context)` context per docs carries `signal` + `progress` (and `sessionID`/`callID` MAY be present on the
  event/context — **unconfirmed**). If sessionID/agent are absent, craftsman must derive them another way (e.g. capture
  from a `tool.execute.before` hook that has them, or from `ctx.session`). This is the single biggest migration risk.
- **G-toolsdir — No `tools/` directory (HIGH).** v2 docs show no `~/.config/opencode/tools/` custom-tool mechanism;
  all tools register via `ctx.tool.transform`. The 27 `tools/*.ts` + `stepCopyTools` + `install_custom_tools_symlink` are
  dead. Consolidate into `setup`. (Confirm v2 has no custom-tools dir; if it does, keep but rewrite to v2 schema.)
- **G-sdkpkg — Client package + HTTP bridge (MED).** `@opencode-ai/sdk` → `@opencode/client`. In-plugin event subscription
  can drop the SDK client via `ctx.event.subscribe()`. The standalone `src/cli/serve.ts` keeps `@opencode/client`. Decide
  whether HTTP `/api/events` is fed by `ctx.event` bridge (plugin) or a separate `@opencode/client` (standalone serve).

---

## 5. Answers to design-doc open questions (§8)

1. **Exact v2 client package name.** Out-of-process: **`@opencode/client`** (`OpenCode.make({ baseUrl, headers })`;
   events `client.event.subscribe()`; RPC `client.rpc(...)`). Node service mgmt: **`@opencode/client/service`**
   (`Service.ensure({ version: v => v.startsWith("2.") })`). In-process (inside plugin): **no SDK needed** — use `ctx`
   domains and `ctx.event.subscribe()`. Not `@opencode-ai/sdk`, not `@opencode/client` for in-plugin.
2. **Install mechanics.** `plugins` key (plural) in `~/.config/opencode/opencode.json`. Entries: bare string
   (published `ndomo`, or `@scope/opencode-plugin`, optional `@version`) **or** `{ "package": "...", "options": {...} }`.
   Local auto-load from `.opencode/plugins/` and `.opencode/plugin/`, plus `file:///abs/path`, `./plugins/local`,
   `../shared/plugin`, absolute path. Published `ndomo` vs `file://` dep both valid; `file://` + `bun install` → real
   copy still works. The installer's `stepRegisterPlugins` must write `plugins`; `stepCopyTools`/`install_custom_tools_symlink` removed.
3. **Target version → dual-support vs clean break.** **Clean break v2.** Current deps are v1 (`@opencode-ai/plugin`/
   `@opencode-ai/sdk` 1.17.7); no active 1.x install requires support. Dual-support (`server()` v1 + `Plugin.define` v2 in
   one default export, supported in OpenCode 1.18.29+) is **not needed** since we fully migrate. Not chosen.
4. **Long-running tools + compaction coverage.** v2 tool `execute` receives `context.signal` for cancellation; the
   BackgroundDispatcher (Bun-internal) survives unchanged. `ctx.session.hook("compaction")` gives `event.messages` +
   `event.result` but does **not** auto-inject orchestrator state (see G-ap). Auto-checkpoint logic lives in tool
   `execute` (`plan_update_status`, `task_update_status`), not in the hook, so it survives as long as tools migrate.

---

## 6. Risk register (consolidated)

| ID | Finding | Impact | Phase | Mitigation |
|---|---|---|---|---|
| R1 | Package rename `@opencode-ai/plugin`→`@opencode/plugin`, entrypoint `Plugin.define` | HIGH | T1 | Mechanical rewrite of `src/plugin.ts` + 27 tools |
| R2 | Hooks → domain `ctx.*.hook` single-event callbacks | HIGH | T1 | Map 4 hooks; verify event fields |
| R3 | Tool return shape `string`→`{content}` (all 46) | HIGH | T1 | Wrap every execute return |
| R4 | G-tool-ctx: `ctx.sessionID`/`agent`/`messageID` in execute | HIGH | T1 | Confirm v2 context; capture from hook or `ctx.session` |
| R5 | G-ap: compaction context injection | HIGH | T1 | Decide summary-vs-messages strategy |
| R6 | G-toolsdir: 27 `tools/*.ts` + install copy obsolete | HIGH | T2 | Consolidate into `setup` transform; delete files + install steps |
| R7 | `@opencode-ai/sdk`→`@opencode/client` + HTTP bridge | MED | T2/T3 | Rename; re-architect `/api/events` via `ctx.event` |
| R8 | Install `plugin`→`plugins` key | MED | T2 | Update `stepRegisterPlugins` + `opencode.json` |
| R9 | `opencode-mem` separate v1 plugin needs v2 migration | MED | T4 | External; track as blocker for full function |
| R10 | v2 API still evolving / docs gaps | MED | all | This audit + gap list; verify on implementation |

---

## 7. Verification checklist (migrate-v1, to satisfy in T4)

- [ ] plugin id `ndomo` + source in active plugin list (`ctx.plugin.list()`)
- [ ] every hook/transform/tool exercised (compaction, tool.execute.before/after, shell.create.before)
- [ ] cleanup verified on reload (no leaked write locks, HTTP server stops)
- [ ] options + persisted state tested in clean project (`ctx.options`, `ctx.storage`)
- [ ] package installed (not workspace link) e2e — `plugins: ["ndomo"]` published OR `file://` real copy
- [ ] tools return `{ content }` and DB rows carry correct `agent`/`sessionID` (G-tool-ctx resolved)

---

## 8. Recommended next step (handoff)

Craftsman task 1 (T1) should start from `src/plugin.ts`: rewrite entrypoint to `Plugin.define`, register the 4 hooks
via `ctx.*.hook`, and register all 46 tools via `ctx.tool.transform` with JSON-Schema `input` + `{ content }` returns,
resolving R2/R3/R5 and confirming R4 against `@opencode/plugin` type defs. T2 consolidates the 27 `tools/*.ts` and
updates install/SDK. T3 handles web/http. T4 verifies.

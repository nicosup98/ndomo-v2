# Agent Reference

## Overview

ndomo defines 21 agents grouped by function (3 primaries + 18 subagents). All agent definitions live as Markdown files in `agents/` with YAML frontmatter specifying model, temperature, permissions, and mode.

## Primaries

Three primary agents operate independently. The user switches between them manually via TUI.

### foreman

**Planner puro.** Analiza, explora, planifica y persiste planes en DB. No implementa. Solo planifica; la ejecución es del craftsman.

- **Model:** minimax/MiniMax-M3 (default), deepseek-v4-flash (budget)
- **Temperature:** 0.3
- **Permissions:** edit (ask), write (ask), bash (ask), question (allow)
- **Delegates to:** scout, scribe, sage, guild (exploración y análisis únicamente)
- **File:** `agents/foreman.md`

Flow (4 pasos):
1. **Aclaración** — identifica intención, pregunta si ambigüo, sugiere craftsman si ≤5 archivos
2. **Exploración** — memory search + scout/scribe/sage/guild según necesidad
3. **Plan Atómico** — desglosa en ≤5 steps con archivos esperados y dependencias
4. **Persistir** — `plan_create` + `task_create_batch` en DB

### craftsman

**Implementador artesano.** Primary agent para bugs, features pequeñas y refactors acotados. Opera en 4 estados según alcance.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (ask con permit list), question (allow)
- **Delegates to:** smiths, painter, chronicler, inspector, scout, scribe (por routing interno)
- **File:** `agents/craftsman.md`

**Cuándo usar:**
- **Ad-hoc (cambio directo):** Tareas ≤5 archivos, bien definidas — cambiar a craftsman en TUI sin pasar por foreman
- **Plan formal:** Foreman creó un plan con tasks asignadas a `craftsman` — craftsman lee `plan_get`/`task_next_for_agent` y ejecuta
- **Diferencia con foreman:** Foreman planifica (solo DB writes), craftsman implementa (code + DB writes). Foreman NO delega a smiths; craftsman sí.

**Threshold 2/5/1:**
| Estado | Archivos | Comportamiento |
|--------|----------|----------------|
| 1 — Trivial | ≤2 | Implementación directa, sin `plan_db` |
| 2 — Multi-archivo acotado | 3-5 | Crea `plan_create` + `task_create_batch` propio |
| 3 — Plan formal | — | Lee plan existente del foreman y ejecuta |
| 4 — Fuera de dominio | >5 | **Rechaza** — "fuera de mi dominio" → cambiar a foreman |

**Routing interno (por extensión de archivo):**
| Extensión / Contexto | Sub-agente |
|---|---|
| `.go` | `go-smith` |
| `.vue` / `.svelte` | `vue-smith` |
| `.ts` / `.tsx` / `.js` / `.jsx` | `js-smith` |
| `.py` | `python-smith` |
| `.rs` | `rust-smith` |
| `.zig` | `zig-smith` |
| UI/design + `type=design` | `painter` (solo vía craftsman) |
| Documentación / markdown | `chronicler` |
| Auditoría / seguridad | `inspector` |
| Sin match | `smith` (genérico) |

`task.metadata.stack` actúa como override explícito sobre la extensión. Si no hay match, usa `smith`.

**Painter solo craftsman:** El agente UI/UX `painter` solo es invocable desde craftsman, no desde foreman. Craftsman decide: painter si `stack="vue"` y `type="design"`, o vue-smith para implementación lógica.

### warden

**Custodio de operaciones.** Primary agent para CI/CD, deploy, releases, monitoring, secrets, branch strategy y security ops. Opera en paralelo con foreman (planificación) y craftsman (implementación) — su dominio es exclusivamente ops.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.3
- **Permissions:** edit (ask), write (ask), bash (ask con read-only allow), webfetch (allow), question (allow), task (allow)
- **Delegates to:** ci-smith, deploy-smith, release-smith, ops-scout (own fleet), sage, inspector (reused)
- **File:** `agents/warden.md`

**Cuándo usar:**
- **Ad-hoc (cambio directo):** Ops simple — cambiar a warden en TUI sin pasar por foreman. Ej: bump version, restart service, audit one-off.
- **Plan formal:** Warden crea plan con `metadata.category="ops"`, dispatcha via `task_create_batch` con agent="ci-smith"/"deploy-smith"/etc.
- **Dispatched:** Foreman crea plan code+ops, dispatcha warden para portions ops. Warden hereda `plan_id` via session.

**Regla de oro:** Warden NUNCA dispatcha a craftsman/smith/foreman. Si la tarea es code+ops → pedir al usuario que foreman planifique primero.

## Explorers

Read-only agents for investigation and research.

### scout

Codebase reconnaissance. Navigates repositories at maximum speed: maps structures, locates symbols, finds patterns, traces dependencies.

- **Model:** opencode-go/minimax-m2.7
- **Temperature:** 0.3
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/scout.md`
- **Use when:** "find where X is defined", "map the auth flow", "what calls this function"

### scribe

External knowledge retrieval. Searches documentation, APIs, libraries, and web resources. Does not modify code.

- **Model:** opencode-go/minimax-m2.7
- **Temperature:** 0.3
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/scribe.md`
- **Use when:** "research best practices for X", "find docs for this library", "what version of Y should we use"

## Builders

Write code. Divided into generic smith and stack-specific smiths.

### painter

UI/UX designer. Handles visual composition, component design, and frontend styling. Triggered only when `stack === "vue"` and `type === "design"`.

- **Model:** opencode-go/kimi-k2.6
- **Temperature:** 0.2
- **Permissions:** edit (allow), write (allow), bash (allow), question (allow)
- **File:** `agents/painter.md`
- **Use when:** "design a login page", "create a dashboard layout", "style this component"

### smith

Generic fast implementation specialist. Stack-agnostic — handles well-defined tasks in any language. Default fallback for unknown stacks.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow), question (allow)
- **File:** `agents/smith.md`
- **Use when:** small fixes, config changes, simple features, mechanical refactors in any language

### go-smith

Go implementation specialist. Idiomatic Go patterns, testing with table-driven tests, concurrency, error handling.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/go-smith.md`

### js-smith

JavaScript/TypeScript implementation specialist. Frontend and backend JS/TS, modern patterns, typing.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/js-smith.md`

### python-smith

Python implementation specialist. Pythonic idioms, type hints, testing with pytest.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/python-smith.md`

### vue-smith

Vue 3 / Pinia implementation specialist. Composition API, `<script setup>`, Vue Router, Pinia stores.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/vue-smith.md`

### zig-smith

Zig 0.16 implementation specialist. Systems programming, Zig idioms, memory management.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/zig-smith.md`

### rust-smith

Rust implementation specialist. Ownership, lifetimes, traits, async/Tokio, zero-cost abstractions, compile-time SQL checks.

- **Model:** opencode-go/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/rust-smith.md`
- **Skills:** `rust-patterns`, `rust-testing`

## Advisors

Provide analysis, guidance, and multi-perspective evaluation. Read-only (edit denied).

### sage

Architecture advisor and high-risk debugger. Deep reasoning for complex problems, trade-off analysis, architecture decisions.

- **Model:** opencode-go/deepseek-v4-pro
- **Temperature:** 0.2
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/sage.md`
- **Use when:** "review this architecture", "debug this complex issue", "what's the best approach for X"
- **Manual call:** `sage <question>`
- **Auto-triggered:** when `type === "debug" && risk === "high"`, or `high risk implement` (as advisory parallel to the stack-smith)

### guild

Multi-LLM consensus and architectural debate. Simulates multiple perspectives to reach consensus on high-risk decisions.

- **Model:** opencode-go/deepseek-v4-pro
- **Temperature:** 0.3
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/guild.md`
- **Use when:** "should we use X or Y architecture", "is this design safe"
- **Note:** Manual delegation only — never auto-routed by the scheduler. The foreman only delegates to guild on explicit user request (`type: "debate"`).

## Quality

Review and documentation agents. Invoked after implementation phases.

### inspector

Code quality and security auditor. Reviews diffs for bugs, anti-patterns, security issues, and style violations.

- **Model:** opencode-go/deepseek-v4-pro
- **Temperature:** 0.2
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/inspector.md`
- **Use when:** "review this diff", "audit this PR", "check for security issues"
- **Auto-triggered:** craftsman invokes inspector on the resulting diff before closing any task

### chronicler

Technical documentation writer. Analyzes code and generates Markdown documentation. Read-only on existing code; writes documentation files.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.2
- **Permissions:** edit (allow), write (allow), bash (deny)
- **File:** `agents/chronicler.md`
- **Use when:** "document this API", "generate README", "write migration guide"

## Ops Sub-Agents

Warden delega en 4 sub-agentes especializados en operaciones:

### ci-smith

**CI/CD pipeline specialist.** Crea/modifica GitHub Actions, GitLab CI, CircleCI workflows.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.5
- **Permissions:** edit (allow for `.github/workflows/*.yml`), bash (allow for `gh workflow*`)
- **Delegates to:** none (focused specialist)
- **File:** `agents/ci-smith.md`

### deploy-smith

**Deployment automation specialist.** Scripts de deploy, Docker, k8s, rollback procedures.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.5
- **Permissions:** edit (allow for `scripts/deploy*`, `Dockerfile*`, `k8s/`)
- **Delegates to:** none
- **File:** `agents/deploy-smith.md`

### release-smith

**Release management specialist.** Semver, CHANGELOG, GitHub releases, branch strategy enforcement.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.3
- **Permissions:** edit (allow for `CHANGELOG.md`, `package.json`)
- **Delegates to:** none
- **File:** `agents/release-smith.md`

### ops-scout

**Infrastructure reconnaissance specialist.** Audit de CI/CD/deploy/monitoring/secrets. Read-only.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.5
- **Permissions:** edit (deny), write (deny), bash (allow read-only)
- **Delegates to:** none
- **File:** `agents/ops-scout.md`
- **Note:** Cross-primary — único sub-agent dispatchable por warden O foreman.

## Routing Tables

Routing is split across two tiers: foreman (planner) and craftsman (implementer). The old centralized scheduler in `src/orchestrator/scheduler.ts` is deprecated.

### Foreman Routing (planning only)

Foreman delegates exclusively to exploration/analysis agents:

| Petición | Delegar a |
|----------|-----------|
| Localizar código / mapear repo / detectar stack | `scout` |
| Research docs / APIs / libraries / versiones | `scribe` |
| Arquitectura / debugging difícil / trade-offs | `sage` |
| Consenso multi-modelo / debate arquitectónico | `guild` (solo manual) |

**NO delegar a:** smiths, painter, chronicler, inspector — esos van al craftsman.

### Craftsman Routing (implementation)

Craftsman selecciona sub-agente por extensión de archivo (`task.files`) con `task.metadata.stack` como override:

| Extensión | Sub-agente |
|-----------|------------|
| `.go` | `go-smith` |
| `.vue` / `.svelte` | `vue-smith` |
| `.ts` / `.tsx` / `.js` / `.jsx` | `js-smith` |
| `.py` | `python-smith` |
| `.rs` | `rust-smith` |
| `.zig` | `zig-smith` |
| UI/design + `type=design` | `painter` |
| Documentación / markdown | `chronicler` |
| Auditoría / diff review | `inspector` |
| Sin match | `smith` (genérico) |

Si no hay match por extensión ni stack, usa `smith` como fallback genérico.

## Custom Agents

See [configuration.md](configuration.md#custom-agents) for instructions on adding new specialist agents to the routing table.

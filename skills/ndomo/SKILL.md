---
name: ndomo
description: >
  Guía de operación del ecosistema ndomo (plans, tasks, sessions, memoria, gates) —
  operating guide for the ndomo ecosystem (plans, tasks, sessions, memory, gates).
  Workflow-first: decision tree, plan/task/session lifecycles, gates T1-T5, routing,
  worktrees, ops warden, obsidian y referencia compacta de las 62 tools.
  Use when working with ndomo, plans, tasks, sessions, dispatch, memory,
  orchestration, routing, gates, worktrees, incidents. Triggers: "skill ndomo",
  "how to use ndomo", "planes", "tareas", "sesiones", "memoria", "gates", "plan", "task".
---

# ndomo — Guía de uso para agentes

Fuente única y compacta de cómo operar ndomo. Prosa en español; tools, estados y comandos en inglés. Stamp: **v0.8.0 / schema v18 / 62 tools / 23 agents** (4 primaries + 19 specialists). Verifica cada afirmación contra `src/plugin.ts` (fuente de verdad de tools).

## 1. Qué es ndomo y sus stores

ndomo es el plugin de orquestación multi-agente de OpenCode. Un agente lo opera vía **62 tools registradas** (`src/plugin.ts:955`, bloque `toolDefs`). Almacena estado en varios stores:

| Store | Ubicación | Contenido |
|---|---|---|
| state DB | `<proyecto>/.ndomo/state.db` (SQLite v18) | plans, plan_tasks, sessions, analyses, ops (deployments/incidents/rollbacks), routing_events (FIFO cap 5000) |
| Memoria | `~/.ndomo/mem/projects/<tag>.db` (SQLite + FlexSearch, otra DB) | memories cross-session, dedup por sha256 |
| Archives | `<proyecto>/.ndomo/archives/plans/` | snapshots markdown auto-generados al archivar un plan |
| Ledgers | `<proyecto>/.ndomo/ledgers/{sessionId}.md` | continuidad portable por sesión (DB-free) |
| Designs | `<proyecto>/.ndomo/designs/YYYY-MM-DD-{slug}-design.md` | design docs (Phase 0) |
| Obsidian | vault externo (config `obsidian.vaultPath`) | proyección unidireccional repo → vault |

Profundidad: `docs/database.md` (schema completo, v1-v18), `docs/configuration.md` (ndomo.json).

## 2. Entrada: decision tree y routing

Ante un prompt del usuario, elegir el primary correcto:

```
¿Tarea ≤2 archivos, bien definida?          → craftsman (TUI) — trivial, sin DB
¿Tarea 3-5 archivos multi-stack?            → craftsman (TUI) — ad-hoc con plan propio
¿Tarea >5 archivos / diseño / ambigua?      → foreman (TUI) — 4 pasos: Aclaración → Exploración → Plan Atómico → Persistir
¿Auditoría PR o read-only?                  → craftsman o scout (según necesite escribir)
¿Análisis / mapeo / onboarding?             → ranger (TUI) — produce analyses, NO toca negocio
¿Ops / CI-CD / deploy / incidente?          → warden (TUI)
```

**REGLA CARDINAL:** los **primaries** (foreman, craftsman, warden, ranger) SIEMPRE se invocan vía **plan + TUI switch** (el usuario cambia de agente en TUI), NUNCA como subagents (perderían su flota de specialists). Los **specialists** (scout, scribe, sage, guild, smiths, painter, chronicler, inspector, ci-/deploy-/release-smith, ops-scout) se despachan SOLO vía su primary: exploración→foreman/ranger, implementación→craftsman, ops→warden.

- foreman delega solo a scout/scribe/sage/guild (guild solo manual, `type:"debate"`). Nunca a smiths/painter/chronicler/inspector.
- craftsman enruta por extensión de archivo (`task.files`) con `metadata.stack` como override: `.go`→go-smith, `.vue`→vue-smith, `.ts/.js`→js-smith, `.py`→python-smith, `.rs`→rust-smith, `.zig`→zig-smith, UI+design→painter (solo vía craftsman), docs→chronicler, auditoría→inspector, sin match→smith.
- warden nunca dispatcha craftsman/smith/foreman. ranger no delega a builders ni quality.
- ranger es primary peer: invocable vía `task_create_batch` con `agent:"ranger"` o consumiendo `analysis_*` (read).

## 3. Ciclo Plan

Estados: `draft` → `approved` → `executing` → `completed|failed|abandoned` → `archived`. Transiciones válidas (`src/db/plan-update-status.ts:58-65`): draft→[approved, abandoned]; approved→[executing, abandoned]; executing→[completed, failed, abandoned]; **completed/failed/abandoned son terminales SIN transición de salida**.

1. **Fase 0 (obligatoria):** clarificar problema + `design_create` → `.ndomo/designs/` (T3 Brainstorm).
2. `plan_create({slug, title, overview, ...})` → crea plan `draft` (+ auto-row de session para FK cuando hay ctx.sessionID). NO usar `session_start` con el mismo sessionID (PK collision).
3. `task_create_batch({planId, tasks:[...]})` — transaccional, order_index secuencial. `plan_approve({id})` es opcional en flujo v2 (foreman 4 pasos lo salta; dispatch directo).
4. `plan_update_status({id, status:"executing"})` → marca ejecución.
5. Cierre: **siempre `dryRun:true` primero** (readiness pre-check, sin mutar). Blockers: `tasks_pending`, `tasks_running`, `sessions_open`, `status_invalid` (este último NO se puede forzar). `orphan_plan` es warning. Excepción: executing→failed degrada blockers a warnings (salvo status_invalid).
6. `plan_update_status({id, status:"completed"|"failed"|"abandoned", force:true, forceReason:"..."})` — `force` + `forceReason` (no vacío) salta blockers; queda auditado en `plan_audit` (trigger `force_close`). Auto-archives a `.ndomo/archives/plans/<slug>-YYYY-MM-DD.md`.

**RECONCILIACIÓN (verificado en `src/plugin.ts:414-440`):** `session_end` marca `abandoned` (con `metadata.reason="session_ended"` + `endedBy`) todo plan de esa session con status `executing` o `approved` sin cerrar. `abandoned` es terminal — un plan abandonado no vuelve a ejecutarse.

## 4. Ciclo Task

Estados: `pending` → `running` → `done|failed` (más `blocked` como estado del enum; `task_review` solo sobre `done`).

1. **Claim:** `task_next_for_agent({agent, planId?})` — devuelve la primera task `pending` de ese agente cuyas dependencias estén TODAS `done`. `task_peek_for_agent` es read-only (no hace claim, no cambia estado).
2. `task_update_status({id, status:"running"})` → setea started_at. Args del tool (`src/plugin.ts:1774-1784`): `id`, `status`, `result?`, `error?`, `force?`, `forceReason?`. Result/error se truncan a 16KB. (Los extras `artifacts`/`metadataPatch`/`reviewedBy`/`reviewedVerdict` están documentados en la capa db — `docs/database.md:483` — pero no en el schema zod del tool; usa `task_add_artifact`/`task_review` para esos efectos.)
3. `task_update_status({id, status:"done", result})` → completed_at + link de `metadata.routingEventId` (best-effort, `link_source:'explicit'`, write-once). En task con gate T1, `done` queda bloqueado hasta `task_verify` passed/waived; `force:true`+`forceReason` waives con audit (`metadata.verificationBypass`).
4. `task_add_artifact({taskId, artifact, role?})` — registra archivos de salida (dedup) y opcionalmente en plan_files. `task_review({taskId, reviewedBy, verdict})` — solo `done`; escribe reviewed_by + `metadata.reviewedVerdict`.
5. Dependencias: `task_create_batch` con `dependencies:[orderIndex]`; inspecciona con `task_dependency_resolver({taskId} | {planId, orderIndex})` → `{canStart, pendingDeps, runningDeps, failedDeps, blockedDeps, doneDeps, missingDeps}`.

## 5. Sessions + ledgers

- `session_start({id, goal, planId?})` — inicia sesión (started_at + last_checkpoint). `session_checkpoint({id, state, keyDecisions?})` — min 1 por fase; appendea key_decisions; además escribe ledger portable. `session_end({id})` — ended_at + reconciliación de planes (ver §3).
- **Auto-checkpoint** (`src/db/auto-checkpoint.ts`): triggers `phase_transition` (tras `plan_update_status` real, no dryRun) y `task_batch_complete` (última task pending → done). Debounced `minIntervalMs` (default 30000), non-blocking, loop-safe (`isAutoCheckpointing`).
- Ledgers: `ledger_create` (idempotente), `ledger_get` (+`raw:true`), `ledger_update` (patch; null limpia campo; sessionId/startedAt inmutables). DB sigue siendo fuente de verdad; ledger best-effort.

## 6. Gates T1-T5

| Gate | Qué es | Tools |
|---|---|---|
| T1 Execution gate | `task_create_batch` con `verificationRequired:true` (o `metadata.verificationRequired`) → `verification_status='pending'` bloquea `done` | `task_verify({taskId, verdict:"passed"|"failed"|"waived", reason?, force?, forceReason?})` — passed inspector-only salvo force; waive requiere reason; override de passed requiere force |
| T2 Critic | Verdict binario sobre diff para el execution gate | `critic_review({diff, verdict:"APPROVED"|"REJECTED", critical?, optimizations?, compliance?, scores?, actionRequired?})` → incluye payload de task_verify; nunca bypassa a inspector |
| T3 Brainstorm / close flow | Phase 0 con `design_create`; cierre de plan con pre-check dryRun + force auditado | `plan_update_status` (dryRun/force/forceReason) |
| T4 Continuity ledger | Checkpoint → `.ndomo/ledgers/` | `ledger_*` + auto-write en session_checkpoint |
| T5 Circuit breaker | `src/db/circuit-breaker.ts`: **4000** llamadas totales / **20** idénticas consecutivas por session (one-shot trip) | trip emite warning + marca task `failed` con `"Circuit breaker: potential loop detected"`; `task_update_status` exenta para recuperación; después bloquea en silencio |

## 7. Memoria

- Buscar primero: `mem_search({query, scope:"project"|"all-projects", type?, tag?, limit?})` (FlexSearch, score 1/(rank+1)). `mem_list` con paginación offset/limit; `mem_stats` agregados.
- Guardar comprimido: `memory_compress({text})` (caveman regex, 0 LLM tokens) → `mem_add({content, type?, tags?, pinned?})` — dedup por sha256 (re-add devuelve el mismo id con `deduplicated:true`).
- `mem_forget({id})` borra. `mem_search` figura en `protectedTools` de la config (`config/ndomo.config.json`) — tools que los subagentes no pueden deshabilitar ni overridear; NO es pruning de contexto.
- Umbral `shouldStoreMemory()`: descarta contenido <20 chars o solo código. Memoria vive en `~/.ndomo/mem/`, NO en state.db.

## 8. Analyses (ranger)

Analyses: tabla standalone linkeable a planes (`source_plan_id`). Consultables por TODOS los primaries.

- `analysis_create({slug, title, projectPath, summary, findingsJson, sourcePlanId?})` — findingsJson debe ser JSON válido; **contract v15**: ranger emite solo findings (observation-only; `proposedAction` → throw).
- Read: `analysis_get({id})`, `analysis_list({sourcePlanId?, agent?, projectPath?, archived?, limit?})`, `analysis_search({query, limit?})` (FTS5 sobre title+summary+findings).
- Mantenimiento: `analysis_update({id, title?, summary?, findingsJson?})`, `analysis_archive({id})` (soft-delete, sale de list default), `analysis_link_plan({id, planId})` — `planId:null` deslinkea.

## 9. Routing

- `route({description, type, stack?, risk?, files?})` — history-aware (routing_events v18) + JEV. Output aditivo `{...decision, eventId}` (best-effort: si falla el insert, omite eventId y nunca rompe). Campos: agent, source (rules|jev|history|hybrid), confidence, alternatives, explain, fallback, explore.
- **Propagar el link (crítico):** cada task del batch debe llevar `metadata.routingEventId = decision.eventId` → `task_update_status` a done/failed linkea el outcome automáticamente. Eventos sin link se clasifican read-time como `inferred` (task terminal del mismo agente en +24h) u `orphan`.
- `classify_intent({prompt, context?})` — advisory (intent + flow recomendado), nunca overridea juicio. `can_parallel({tasks})` — check de rutas paralelas (conflictos de files + dependencias). `validate_task_dependencies({planId, apply?})` — DAG por pares (cap 8 tasks/28 pares); con `apply:true` mergea sugerencias SOLO en tasks pending.
- Inspect: `stats({query:"routing"})` o CLI `ndomo stats --routing` (tabla) / `--json` (key `routing`).

## 10. Worktrees, deepwork y background dispatch

- **Worktrees** para cambios riesgosos/paralelos: `worktree_create({slug, branch, agent?, description?})` (assertSafeName anti shell-injection), `worktree_list`, `worktree_verify` (integridad), `worktree_remove({slug, abandon?})`. Merge solo con confirmación explícita del usuario.
- **Deepwork** (multi-file/arquitectura): plan en fases + sage gates + worktree `.slim/worktrees/<slug>/`; foreman pide confirmación del usuario antes del merge.
- **Background dispatch**: `dispatch({agent, description, files?, worktree?})` → taskId pending; `active_tasks`, `background_task_status({taskId})`, `background_task_cancel({taskId})`.
- **No write overlap:** dos agentes jamás editan el mismo archivo en paralelo. `canRunParallel()` rechaza conflictos de files y cadenas de dependencias; tasks sin files explícitos se asumen no conflictivas.

## 11. Ops warden

Flujo 3-call de incident response (`docs/workflows.md:520-546`):

```
1. Detect: deployment status='failed' o alerta externa
2. incident_create({title, severity:"sev1"|"sev2"|"sev3"|"sev4", summary?, triggeredByDeploymentId?}) → status='open'
3. rollback_record({deploymentId, plan, incidentId?, status?, newDeploymentId?}) → RollbackExecution
   status: planned → approved → dry_run → executing → success|failed|cancelled
```

Tablas ops (v13): `environments`, `releases`, `deployments` (planned/in_progress/succeeded/failed/rolled_back), `incidents` (open/triaging/mitigated/resolved/postmortem), `rollback_executions`. Deployments/releases/environments se gestionan a nivel DB (sin tools dedicadas; registra vía `incident_create`/`rollback_record` + `plan_progress` para monitoreo).

## 12. Obsidian

Capa brain **one-way** (repo → vault), determinista e idempotente (SHA-256 skip):

- `obsidian_export({entityType:"plan"|"task"|"design"|"memory", entityId, scope:"single"|"plan", kind?})` — `scope:"plan"` exporta el plan + sus tasks no-archivadas (fail-fast). Responde SIEMPRE envelope `{ok:true,data} | {ok:false,error}` (nunca throw).
- `obsidian_read_note({path} | {entityType, entityId})` — lee la nota proyectada. Sin reverse sync, watchers ni CLI. Requiere bloque `obsidian` en ndomo.json.

## 13. Referencia compacta de las 62 tools

Agrupadas por dominio (nombre — propósito — args clave). Fuente: `src/plugin.ts:955-2544`.

### Routing / parallel (6)

| Tool | Propósito | Args |
|---|---|---|
| `route` | Enruta tarea a specialist (history-aware + JEV) | description, type (implement/explore/research/design/debug/audit/document/debate), stack?, risk?, files? |
| `can_parallel` | ¿Un set de decisiones de routing puede correr en paralelo? | tasks (JSON de RoutingDecision[]) |
| `classify_intent` | Classifica prompt con JEV (intent+flow, advisory) | prompt, context? |
| `classify_tests` | Verdict de battery de tests (green/red/mixed/none) | output, exitCode?, expectedTests?, runner? (bun/vitest/jest/pytest/go/unknown), context? |
| `code_traffic_light` | Escanea diff por patrones de riesgo (secrets, injection…) | diff, context? |
| `validate_task_dependencies` | DAG de dependencias por pares; apply mergea en pending | planId, apply? |

### Task dispatch / worktree / background (8)

| Tool | Propósito | Args |
|---|---|---|
| `dispatch` | Background task a specialist, devuelve taskId | agent, description, files?, worktree? |
| `active_tasks` | Tasks activas (pending+running) | — |
| `background_task_status` | Estado de una background task | taskId |
| `background_task_cancel` | Cancela pending/running | taskId |
| `worktree_create` | Crea git worktree aislado | slug, branch, agent?, description? |
| `worktree_list` | Worktrees activos | — |
| `worktree_remove` | Remueve worktree por slug | slug, abandon? |
| `worktree_verify` | Verifica integridad de worktrees | — |

### Memory (6)

| Tool | Propósito | Args |
|---|---|---|
| `memory_compress` | Comprime texto a caveman (regex) | text |
| `mem_add` | Añade memoria (dedup sha256) | content, type?, tags?, pinned? |
| `mem_search` | Busca (FlexSearch) proyecto o cross-project | query, scope? (project/all-projects), type?, tag?, limit? |
| `mem_list` | Lista memorias con paginación | scope?, type?, tag?, limit?, offset? |
| `mem_forget` | Borra memoria por id | id |
| `mem_stats` | Estadísticas agregadas | scope? |

### Obsidian (2)

| Tool | Propósito | Args |
|---|---|---|
| `obsidian_export` | Proyecta plan/task/design/memory al vault (idempotente) | entityType, entityId, scope? (single/plan), kind? |
| `obsidian_read_note` | Lee nota proyectada | path? o entityType?+entityId? |

### Meta (3)

| Tool | Propósito | Args |
|---|---|---|
| `ndomo_write_unlock` | Admin: libera lock de escritura stale | filepath |
| `status` | Health check del plugin | — |
| `stats` | Scorecard por agente o report routing | since? (7d/30d/all), agent?, query? (scorecard/routing) |

### Plan (9)

| Tool | Propósito | Args |
|---|---|---|
| `plan_create` | Crea plan draft | slug, title, overview, approach?, priority?, complexity? (1-5), sessionId?, metadata?, files? |
| `plan_get` | Plan por id o slug | id? o slug? |
| `plan_list` | Lista filtrada | status?, sessionId?, limit? |
| `plan_search` | FTS5 sobre planes | query, limit?, includeArchived? |
| `plan_approve` | Sella approved_at | id |
| `plan_delete` | Borrado permanente (rechaza draft/tasks activas) | id, confirm (req) |
| `plan_update_status` | Transición + readiness checks + auto-archive | id, status, dryRun?, force?, forceReason? |
| `plan_progress` | Progreso (task counts + %) | planId?, owner? |
| `plan_files_write` | Registra files con rol (ej. input/modified/output/reference; `role` es string libre) | planId, files[] ({filePath, role}) |

### Task (10)

| Tool | Propósito | Args |
|---|---|---|
| `task_create_batch` | Crea tasks transaccional (order_index secuencial) | planId, tasks[] ({description, agent, files?, complexity?, dependencies?, metadata?, verificationRequired?}) |
| `task_list` | Tasks de un plan | planId, status?, includeArchived? |
| `task_update_status` | Transición + result/error (16KB) | id, status, result?, error?, force?, forceReason? |
| `task_verify` | Verdict del execution gate T1 | taskId, verdict (passed/failed/waived), result?, reason?, force?, forceReason? |
| `task_search` | FTS5 sobre tasks | query, limit?, includeArchived? |
| `task_next_for_agent` | Claim de siguiente task pendiente (deps done) | agent, planId? |
| `task_dependency_resolver` | Estado de deps de una task | taskId? o planId?+orderIndex? |
| `task_peek_for_agent` | Peek read-only sin claim | agent, planId?, limit? |
| `task_add_artifact` | Appendea artifact (dedup) + plan_files opcional | taskId, artifact, role? |
| `task_review` | Review solo sobre done; sets reviewed_by + verdict | taskId, reviewedBy, verdict |

### Ops (2)

| Tool | Propósito | Args |
|---|---|---|
| `incident_create` | Registra incidente ops (status open) | title, severity (sev1-4), summary?, triggeredByDeploymentId?, metadata? |
| `rollback_record` | Registra rollback (deployment requerido) | deploymentId, plan, incidentId?, status?, newDeploymentId?, metadata? |

### Escalation (1)

| Tool | Propósito | Args |
|---|---|---|
| `task_escalate` | Escala al foreman (plan stub con metadata.escalatedFrom/By + checkpoint) | reason (req), sourcePlanId?, sourceTaskId?, suggestedApproach? |

### Analyses (7)

| Tool | Propósito | Args |
|---|---|---|
| `analysis_create` | Crea analysis (findingsJson validado; ranger observation-only) | slug, title, projectPath, summary, findingsJson, sourcePlanId?, agent?, sessionId? |
| `analysis_get` | Analysis por id (findings parseado) | id |
| `analysis_list` | Lista con filtros | sourcePlanId?, agent?, projectPath?, archived?, limit? |
| `analysis_search` | FTS5 sobre analyses | query, limit? |
| `analysis_update` | Patch parcial (bumps updated_at) | id, title?, summary?, findingsJson? |
| `analysis_archive` | Soft-delete idempotente | id |
| `analysis_link_plan` | Linkea/deslinkea plan fuente | id, planId (null = unlink) |

### Sessions / ledgers (6)

| Tool | Propósito | Args |
|---|---|---|
| `session_start` | Inicia sesión (continuidad cross-agent) | id, goal, planId?, metadata? |
| `session_checkpoint` | Checkpoint + key decisions (+ ledger write) | id, state, keyDecisions? |
| `session_end` | Cierra sesión + reconcilia planes abandonados | id |
| `ledger_create` | Crea/overwrite ledger portable en .ndomo/ledgers/ | sessionId, goal, planId?, state?, keyDecisions?, agentHistory?, metadata?, startedAt? |
| `ledger_get` | Lee ledger (parsed o raw) | sessionId, raw? |
| `ledger_update` | Patch de ledger (null limpia campo) | sessionId, goal?, planId?, state?, keyDecisions?, agentHistory?, metadata?, lastCheckpoint?, endedAt?, outcome? (success/partial/failed/abandoned) |

### Design / critic (2)

| Tool | Propósito | Args |
|---|---|---|
| `design_create` | ADR/brainstorm doc en .ndomo/designs/ (d2 validate opcional) | slug, title, problem, goals?, constraints?, scope?, exclusions?, options?, decision?, tradeoffs?, consequences?, diagrams?, openQuestions?, planId?, sessionId?, agent?, date? |
| `critic_review` | Review binario APPROVED/REJECTED + payload task_verify | diff, verdict (APPROVED/REJECTED), critical?, optimizations?, compliance?, actionRequired?, scores? |

## 14. Anti-patterns (errores recurrentes)

- ❌ **Primaries como subagents** (pierden su flota de specialists). → Siempre plan + TUI switch, salvo ranger vía `agent:"ranger"` en task_create_batch.
- ❌ **Saltar gates:** marcar `done` en task con verificationRequired sin `task_verify` (o sin force+forceReason auditado). → El gate lanza; usa `task_verify`.
- ❌ **Cerrar plan con tasks pendientes** → `tasks_pending` bloquea; usa dryRun primero, completa tasks o force con razón.
- ❌ **No propagar `metadata.routingEventId`** al crear tasks tras `route` → routing_events quedan orphans; pierdes trazabilidad del outcome.
- ❌ **Tasks sin planId** (`task_create_batch` requiere planId; task_update_status linkea plan desde la task) → tasks huérfanas (warning `orphan_plan`).
- ❌ **Ignorar memoria:** no hacer `mem_search` antes de planificar/implementar, o guardar sin `memory_compress`.
- ❌ **Escritura solapada en paralelo:** dispatchear dos writers sobre el mismo archivo → viola la regla de no write overlap; verifica con `can_parallel`.
- ❌ Archivar/borrar con `plan_delete` sin `confirm:true` → rechazado por diseño; no forzar.
- ❌ `session_start` con el mismo `ctx.sessionID` que creó el plan → PK collision (auto-row ya existe).

## 15. CLI quick ref

```bash
bun run src/cli/index.ts <command>   # entry unificado (src/cli/index.ts:29-105)
# Commands:
status     # planes agrupados por status con task counts
stats      # scorecard por agente [--since 7d|30d|all] [--agent] [--json] [--routing]
audit      # self-audit: drift/permissions/counts/config/manifest (score 1-100; exit 1 si ERROR)
analyses   # list | get | search | archive
vacuum     # reclaim de espacio en .ndomo/state.db
smoke      # smoke tests
install    # instala agents/skills/config en ~/.config/opencode/
plan       # create | list | show | update | approve | complete | delete | assign-task
task       # create | list | show | update | reassign | complete | fail
```

También ejecutables directos: `bun run src/cli/plan.ts ...`, `bun run src/cli/task.ts ...`, `bun run src/cli/stats.ts ...`, `bun run src/cli/audit.ts --json`.

## 16. Fuentes y profundidad

- Tools (fuente de verdad): `src/plugin.ts` (bloque `toolDefs`, línea 955).
- Workflows, lifecycles, gates: `docs/workflows.md` (decision tree, foreman 4 pasos, craftsman 4 estados, T3 close flow, auto-checkpoint, background dispatch, warden 3-call).
- Schema DB v1-v18 + tools por dominio: `docs/database.md` (tables, FTS5, migraciones, auto-archive, memoria embedded, ops v13).
- Agentes (23): `docs/agents.md` (primaries, fleets, routing tables, ranger cross-primary).
- Config: `docs/configuration.md` (ndomo.json, presets, provider override, mem/circuitBreaker/obsidian).
- Routing intelligence + JEV: `docs/features/harness-intelligence.md`.
- Installer: `docs/installer.md`; ops docs: `docs/operations/`.

Stamp: **ndomo v0.8.0 — schema v18 — 62 tools — 23 agents**.
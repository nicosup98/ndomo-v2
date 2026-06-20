# Feature: Primary Craftsman — refactor arquitectónico (v2)

**Slug:** `feature-flexible-builder`
**Status:** Draft (spec v2)
**Plan ID:** `be21c801-b770-4d82-979a-2bb5186928f1`
**Plan slug:** `flexible-builder-v2`
**Created:** 2026-06-19
**Supersedes:** `docs/features/feature-flexible-builder-v1.md`

---

## 1. Resumen ejecutivo

Refactor arquitectónico mayor del ecosistema ndomo. Dos cambios estructurales que transforman el modelo de orquestación:

1. **Foreman simplificado a 4 pasos** (Aclaración → Exploración → Plan atómico → Persistir): se eliminan 6 pasos del flujo original de 10 (Brief de Delegación, Trivium en Vivo, Reconciliación, Validación, Reporte Final). Foreman pasa de orquestador ejecutor a **planner puro**: planifica y persiste en DB; la ejecución la toma otro agente.

2. **Nuevo primary `craftsman`** (antes `builder` en v1): agente implementador disciplinado con threshold estricto 2/5/1. Ataca bugs, features pequeñas y refactors acotados sin pasar por el ciclo de planificación del foreman. Opera con 4 estados de complejidad progresiva.

El user alterna manualmente entre foreman (planificación formal) y craftsman (ejecución directa) mediante el TUI. No hay dispatch automático ni enrutamiento foreman→craftsman — la separación es manual por diseño.

**Decisión clave del grill:** El nombre final es `craftsman` (no `builder`). El threshold es **2/5/1** (no 1/2-5/3 como en v1). El prompt del craftsman incluye 4 estados (no 3). Foreman baja a 4 pasos puramente planificadores.

---

## 2. Contexto y motivación

### 2.1 Problemas del foreman original (10 pasos)

El `foreman` (`agents/foreman.md`) operaba con un flujo de 10 pasos obligatorios que mezclaba planificación con ejecución:

| # | Paso | Problema |
|---|------|----------|
| 1 | Aclaración | OK — necesario |
| 2 | Memory Search | OK — necesario |
| 3 | Routing | OK — necesario |
| 4 | Plan Atómico | OK — necesario |
| 5 | Brief de Delegación | Inflado: el prompt del subagente ya contiene el objetivo |
| 6 | Trivium en Vivo | Contradictorio: foreman no debe implementar |
| 7 | Reconciliación | Innecesario si craftsman ejecuta completo |
| 8 | Validación | Craftsman corre sus propios tests |
| 9 | Reporte Final | Craftsman reporta en su output |

**Evidencia:** `agents/foreman.md:162-200` — secuencia de 10 pasos que el foreman debía seguir en cada request.

### 2.2 Grietas específicas identificadas

| Grieta | Ubicación en v1 | Impacto |
|--------|-----------------|---------|
| Trivium ≤5 líneas, 1 archivo, 0 nuevos exports | `agents/foreman.md:29-34` | Foreman no puede corregir ni un typo sin delegar |
| No hay modo ad-hoc; toda tarea requiere `plan_create` + `task_create_batch` | `agents/foreman.md:238` | Tareas de 1 archivo requieren ciclo completo de plan_db |
| `session_start` colisiona con `ctx.sessionID` | `docs/bugs/plan-create-orphan-fk.md:60-70` | `plan_approve`/`plan_update_status` fallan sin `session_start` explícito |
| `task_update_status` trunca `result`/`error` a 16KB | `src/db/tasks.ts:109-121` | Outputs grandes se pierden sin advertencia |
| Foreman monopoliza rol de "único primary" | `agents/foreman.md:28` y `agents/*.md` (`mode: subagent`) | User no puede delegar directamente a un smith |
| Routing estático en scheduler | `src/orchestrator/scheduler.ts:41-47` | No hay detección dinámica de stack |
| `opencode.json` ausente en el repo | `glob("*opencode.json*")` → 0 resultados | Config global no versionada |
| Sin asociación plan↔archivos | `src/db/schema.ts` | No hay trazabilidad de qué archivos toca cada plan |
| Sin `original_plan_data` | `src/db/schema.ts` | No hay audit trail de "qué se planeó vs qué se hizo" |
| Sin `plan_delete` | `src/plugin.ts` | No hay forma segura de eliminar planes huérfanos |

### 2.3 Diferencias clave entre v1 y v2

| Aspecto | v1 (`builder`) | v2 (`craftsman`) |
|---------|----------------|-------------------|
| Nombre | `builder` | `craftsman` (confirmado en grill) |
| Estados | 3 (trivial, ad-hoc, formal) | 4 (con threshold 2/5/1) |
| Threshold archivos | 1 / 2-5 / >5 | ≤2 Estado 1, 3-5 Estado 2, >5 Estado 4 |
| Foreman | Sin cambios (10 pasos) | Simplificado a 4 pasos (planner puro) |
| Cross-session close | `created_by` básico | `executed_by_agent` + `executed_by_session` + `created_by_agent` |
| Migraciones DB | v6 + v7 | v6 (original_plan_data) + v7 (plan_files) + v8 (agent/session audit) |
| Painter routing | Foreman | Solo craftsman |
| Caveman | 14 agents target | Mismos 14 + snippet estándar |
| `plan_delete` | Fase 3 | Fase 1 (priorizada) |
| Plan ≤5 steps | Soft warning | Soft warning + log |

---

## 3. Análisis comparativo con nicosup98/ndomo

### 3.1 Arquitectura referencia: architect + builder + qagent

El proyecto referencia `nicosup98/ndomo` (opencode-core-slim) define tres modos de trabajo:

| Modo | Agente | Cuándo |
|------|--------|--------|
| Plan formal | `architect` (primary) | Tarea multi-archivo, necesita diseño |
| Ejecución directa | `builder` (primary) | Tarea bien definida, 1-5 archivos |
| Ad-hoc audit | `qagent` (ad-hoc tool) | Scope se deriva del query |

**Patrón clave:** `architect` NO usa `task` para invocar `builder`. Ambos son primaries que se comunican vía `plan_db` asíncrona. El user cambia de agente manualmente en el TUI.

### 3.2 Tabla comparativa ndomo-v1 vs nicosup98/ndomo vs ndomo-v2

| Aspecto | ndomo-v1 (foreman 10 pasos) | nicosup98/ndomo | ndomo-v2 (craftsman + foreman 4 pasos) |
|---------|-----------------------------|-----------------|----------------------------------------|
| Default agent | foreman (primary) | `build` (built-in) | foreman (primary planner) |
| Implementador | foreman delega a smiths | builder/scout/qagent | **craftsman** (primary implementer) |
| Modo trivial | Trivium ≤5 líneas + plan_db | `build` single-turn | Craftsman Estado 1 (sin plan_db) |
| Modo plan formal | foreman → 10 pasos → smiths | architect → plan_db → builder | Foreman 4 pasos → plan_db → craftsman |
| Coordinación | `task` síncrono | `plan_db` async + TUI switch | `plan_db` async + TUI switch |
| Audit trail | Solo `created_at`/`updated_at` | `original_plan_data` | `original_plan_data` + agent/session FK |
| Plan↔file | No existe | `plan_files` | `plan_files` |
| Tono global | Caveman parcial (foreman + algunos) | Caveman en TODOS | Caveman en TODOS los 14 + craftsman |
| `plan_delete` | No existe | Rechaza si `status='pending'` | Safety 3-capas |
| Plan ≤5 steps | No hay regla | Regla en architect.md | Soft warning en task_create_batch |

### 3.3 Por qué el patrón async + user switch gana

Modelo v1 (foreman 10 pasos):
1. Foreman crea plan en DB (2 writes)
2. Foreman crea tasks batch (N writes)
3. Foreman llama `task` para cada smith (N LLM invocations)
4. Foreman espera resultados (N context switches)
5. Foreman reconcilia resultados (N reads)

Modelo v2 (foreman 4 pasos + craftsman):
1. Foreman crea plan en DB (1-2 writes) — solo si >5 archivos o diseño arquitectura
2. User cambia a craftsman en TUI (0 LLM tokens)
3. Craftsman lee plan y ejecuta (1 read + N writes)
4. Craftsman cierra plan con `plan_update_status("completed")`

**Diferencia clave:** El modelo v2 gasta ~60% menos tokens en coordinación porque el "router" (foreman) solo escribe a DB, no invoca LLMs secundarios. Craftsman opera autónomamente.

---

## 4. Decisiones de diseño

### D1. Nombre `craftsman` (no `builder`)

**Decisión:** El primary implementador se llama `craftsman`, no `builder` como en v1.

**Justificación:** Decisión del grill. `craftsman` evoca artesanía disciplinada (implementación precisa, threshold estricto, 4 estados). `builder` quedó descartado por ambigüedad con "builder pattern" y por la connotación genérica en el referencia.

**Archivo:** `agents/craftsman.md`

### D2. Threshold estricto 2/5/1

**Decisión:** El craftsman opera con threshold numérico estricto:

| Estado | Archivos | Comportamiento |
|--------|----------|----------------|
| Estado 1 | ≤2 archivos | Implementación directa, sin plan_db |
| Estado 2 | 3-5 archivos | Implementación con plan_db (crea plan y tasks) |
| Estado 3 | — | Lee plan existente del foreman y ejecuta |
| Estado 4 | >5 archivos | **Rechaza** — "fuera de mi dominio" → cambiar a foreman |

**Diferencia con v1:** v1 proponía 1/2-5 con threshold 1 archivo para Estado 1. v2 sube a ≤2 archivos para Estado 1, reflejando que fixes de 2 archivos son comunes y no requieren plan_db.

**Enforcement:** Solo por prompt (no hay validación en código). Craftsman es un primary agent; su prompt es la única barrera.

### D3. Routing interno: `task.files` extensión + `metadata.stack`

**Decisión:** El craftsman decide a qué sub-smith delegar basándose en (1) extensión de archivo en `task.files`, (2) `task.metadata.stack` si existe, (3) LLM fallback.

| Extensión | Sub-smith |
|-----------|-----------|
| `.go` | `go-smith` |
| `.vue`, `.svelte` | `vue-smith` |
| `.ts`, `.tsx`, `.js`, `.jsx` | `js-smith` |
| `.py` | `python-smith` |
| `.rs` | `rust-smith` |
| `.zig` | `zig-smith` |
| Sin match | `smith` (genérico) |

**Archivo:** `agents/craftsman.md` — tabla de routing interno.

### D4. Painter solo disponible vía craftsman

**Decisión:** `painter` (UI/UX designer) solo es invocable desde craftsman, no desde foreman.

**Justificación:** Foreman es planner puro (4 pasos). Si hay componente UI, craftsman decide: painter si `stack === "vue"` y `type === "design"`, o vue-smith si es implementación lógica.

**Diferencia con v1:** v1 no especificaba painter routing — quedaba como responsabilidad del foreman.

### D5. Cross-session close con audit trail completo

**Decisión:** Tres nuevos campos en tabla `plans`:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `created_by_agent` | TEXT | Agente que creó el plan (`foreman` o `craftsman`) |
| `executed_by_agent` | TEXT | Agente que ejecutó (`craftsman`, `go-smith`, etc.) |
| `executed_by_session` | TEXT FK → sessions.id | Sesión en que se ejecutó |

**Justificación:** Permite trazabilidad cross-session: "qué agente creó este plan, qué agente lo ejecutó, en qué sesión". Especialmente útil cuando foreman planifica y craftsman ejecuta en sesiones separadas.

**Comportamiento:**
- `plan_create` setea `created_by_agent` desde `ctx.agent`
- `task_update_status` / `plan_update_status` setea `executed_by_agent` y `executed_by_session` al primer `running`
- Write-once: no se sobrescriben si ya están seteados

### D6. `plan_delete` en Phase 1 (priorizada)

**Decisión:** `plan_delete` tool se implementa en Phase 1 (no Phase 3 como en v1).

**Safety checks:**
1. Rechaza si `confirm !== true`
2. Rechaza si `plan.status === 'pending'`
3. Rechaza si hay tasks `pending` o `running`
4. CASCADE: borra plan_tasks, plan_tags, plan_files, sessions ON DELETE SET NULL

### D7. Plan ≤5 steps: soft warning (no bloqueo)

**Decisión:** `task_create_batch` emite `console.warn` si `tasks.length > 5`. No bloquea. La regla se documenta en el prompt del foreman.

**Justificación:** Bloquear sería contraproducente — el usuario podría tener razón. El warning es suficiente para que el foreman reevalúe.

### D8. Caveman global snippet estándar

**Decisión:** Insertar snippet exacto al inicio del prompt de 14 agents (después del frontmatter, antes del primer heading):

```
Tono: caveman por default, nivel full. Activa siempre.
Excepción: prosa normal para advertencias de seguridad,
acciones irreversibles o ambigüedad multi-paso.
```

**Agentes:** chronicler, go-smith, guild, inspector, js-smith, painter, python-smith, rust-smith, sage, scout, scribe, smith, vue-smith, zig-smith.

**NO tocar:** `agents/craftsman.md` (ya incluye caveman en su prompt), `agents/foreman.md` (ya tiene caveman).

---

## 5. Diseño del craftsman

### 5.1 Frontmatter YAML

```yaml
---
description: Implementador Artesano / Disciplined Craftsman (modo ad-hoc o planificado)
mode: primary
model: opencode-go/deepseek-v4-flash
temperature: 0.1
permission:
  edit: allow
  write: allow
  bash:
    "*": ask
    "git status*": allow
    "git log*": allow
    "git diff*": allow
    "git add *": allow
    "git commit*": allow
    "git checkout*": ask
    "git push*": ask
    "ls *": allow
    "cat *": allow
    "mkdir *": allow
    "mv *": allow
    "cp *": allow
    "bun *": allow
    "npm *": allow
    "rm *": ask
  webfetch: deny
  question: allow
  task:
    "scout": allow
    "scribe": allow
    "smith": allow
    "go-smith": allow
    "js-smith": allow
    "vue-smith": allow
    "python-smith": allow
    "rust-smith": allow
    "zig-smith": allow
    "painter": allow
  plan_db: allow
---
```

**Diferencias con el foreman:**
- `mode: primary` (NO subagent)
- `task` permitido solo a subagents implementadores + painter
- `task` NO permitido a foreman, guild, sage (son planners/advisors)
- `task` permitido a chronicler (post-implementation docs) e inspector (review gate) — decisión confirmada en user dialog v2
- Permisos `edit: allow`, `bash: ask` (craftsman implementa; foreman solo planifica)
- `plan_db` tools disponibles pero condicionales (Estado 1 no las usa)

### 5.2 Prompt con 4 estados

```
# Rol: Craftsman (Implementador Artesano)

Eres un **primary agent** diseñado para implementar código con precisión
artesanal. Atacas bugs, features pequeñas y refactors acotados. Operas en
4 estados según el alcance del trabajo. Cuando el alcance excede tu umbral,
escalas al foreman.

## Tono
Caveman nivel full SIEMPRE. Cero saludos, cero justificaciones.

## Threshold estricto 2/5/1

### Estado 1: Trivial (≤2 archivos, sin plan_db)
**Cuándo:** ≤2 archivos, cambios acotados (≤50 líneas diff), sin dependencias externas.
**Flujo:**
1. Lee archivos objetivo
2. Implementa cambios
3. Corre validación (typecheck / tests / lint)
4. Commit opcional (preguntar al user)
5. Reporta directo: archivos, líneas, verificación
**NO crea plan_create. NO toca plan_db.**

### Estado 2: Multi-archivo acotado (3-5 archivos, con plan_db)
**Cuándo:** 3-5 archivos, cambios que cruzan stacks, o necesita tracking cross-session.
**Flujo:**
1. `plan_create` con slug, overview, approach (1 línea cada uno)
2. `task_create_batch` con steps (máximo 5)
3. Para cada step: `task_update_status("running")` → implementar → `task_update_status("done")`
4. Al final: `plan_update_status("completed")`
**Obligatorio si toca más de 1 stack o requiere trazabilidad.**

### Estado 3: Plan formal (lee plan_db existente)
**Cuándo:** El foreman ya creó un plan con tasks asignadas a craftsman.
**Flujo:**
1. `plan_get({id})` o `task_next_for_agent({agent: "craftsman"})`
2. Lee plan_data completo: overview, approach, contexto
3. Implementa TDD: test → code → refactor
4. `task_update_status("done")` con reporte
5. Si todas las tasks hechas: `plan_update_status("completed")`

### Estado 4: FUERA DE MI DOMINIO (>5 archivos)
**Cuándo:** La tarea involucra >5 archivos o requiere diseño de arquitectura.
**Acción:**
→ Reportar: `[FUERA DE MI DOMINIO]` + cuantos archivos/por qué
→ Sugerir cambiar a `foreman` en TUI
→ NO implementar parcialmente

### Regla de selección
```
¿Archivos ≤ 2 y sin dependencias externas?
  → Estado 1: trivial (0 writes a DB)
¿Archivos 3-5 o necesita tracking?
  → Estado 2: plan_db propio
¿Plan existente con tasks para craftsman?
  → Estado 3: ejecutar plan formal
¿Archivos > 5 o requiere diseño?
  → Estado 4: fuera de dominio → foreman
```

## Routing interno (delegación a sub-smiths)
Cuando necesites implementación especializada, usa:

| Extensión archivo | Sub-smith |
|---|---|
| `.go` | `go-smith` |
| `.vue` / `.svelte` | `vue-smith` |
| `.ts` / `.tsx` / `.js` / `.jsx` | `js-smith` |
| `.py` | `python-smith` |
| `.rs` | `rust-smith` |
| `.zig` | `zig-smith` |
| UI/design + `type=design` | `painter` |
| Sin match | `smith` (genérico) |

Si `task.metadata.stack` existe, úsalo como override explícito.
Si no hay match y no hay stack, usa `smith`.

## Cross-session close
- `executed_by_agent`: siempre `craftsman`
- `executed_by_session`: siempre `current_session_id` (ctx.sessionID)
- `created_by_agent`: setear en `plan_create` si creaste el plan

## TDD workflow
1. Test first (si existen tests en el proyecto)
2. Code mínimo para pasar
3. Refactor
4. Verificar con suite del scope
5. Commit atómico

## Lo que NO puedes hacer
- ❌ Invocar foreman, guild, sage vía task
- ⚠️ Invocar chronicler solo post-implementación; inspector solo como review gate (no chaining entre ambos)
- ❌ Editar prompts de otros agents
- ❌ Editar tools MCP
- ❌ Usar `plan_approve`
- ❌ Modificar archivos sin leerlos primero

## Output format
```
cambios:
  - archivo:linea — desc — verified: OK
tests:
  - typecheck: passed
  - test suite: N/N passed
plan:
  - id: (si se creó/usó)
  - estado: completed | ad-hoc (no plan_db)
```

## Caveman skill
Activa siempre. Excepción: prosa normal para advertencias de
seguridad, acciones irreversibles o ambigüedad multi-paso.
```

---

## 6. Foreman nuevo flow: 4 pasos (planner puro)

### 6.1 Comparativa 10 pasos → 4 pasos

| v1 (10 pasos) | v2 (4 pasos) | Diferencia |
|---------------|--------------|------------|
| 1. Aclaración | **1. Aclaración** | Se conserva |
| 2. Memory Search | **2. Exploración** | Se fusiona: memory + scout/scribe/sage/guild |
| 3. Routing | — | Routing implícito en la exploración |
| 4. Plan Atómico | **3. Plan Atómico** | Se conserva, más liviano |
| 5. Brief de Delegación | — | Eliminado: craftsman lee plan_db directamente |
| 6. Trivium en Vivo | — | Eliminado: craftsman implementa |
| 7. Reconciliación | — | Eliminado: craftsman ejecuta todo |
| 8. Validación | — | Eliminado: craftsman corre tests |
| 9. Reporte Final | — | Eliminado: craftsman reporta |
| — | **4. Persistir** | Nuevo: plan_create + write plan_db |

### 6.2 Flujo detallado

#### Paso 1: Aclaración
- Identificar intención en 1-2 frases
- Si ambigüedad: `question` al usuario
- Si la tarea es ≤5 archivos y bien definida → sugerir `craftsman`
- Si >5 archivos o requiere diseño → continuar con planificación

#### Paso 2: Exploración
- `memory({mode:"search", scope:"project"})` — decisiones pasadas
- Delegar a subagentes según necesidad:
  - `scout` — mapear repo, encontrar archivos, detectar stack
  - `scribe` — investigar APIs, versiones, docs externas
  - `sage` — evaluar trade-offs arquitectónicos
  - `guild` — solo si usuario pide debate explícito
- NO delegar a smiths, painter, chronicler, inspector

#### Paso 3: Plan Atómico
- Desglosar en ≤5 steps top-level
- Cada step: `(Acción) → archivos esperados → dependencias`
- Estimar complejidad (1-5) y riesgo (low/medium/high)

#### Paso 4: Persistir
- `plan_create` con slug, overview, approach
- `task_create_batch` con steps (máximo 5, warning si >5)
- NO crear `session_start` (lo hace craftsman al ejecutar)
- NO ejecutar tasks — craftsman las toma via `task_next_for_agent`

### 6.3 Routing table del foreman (v2)

| Petición | Delegar a |
|----------|-----------|
| Explorar código / mapear repo | `scout` |
| Investigar APIs / docs / versiones | `scribe` |
| Arquitectura / trade-offs / debugging difícil | `sage` |
| Debate multi-perspectiva | `guild` (solo manual) |

NOTA: foreman solo planifica. Ejecución es craftsman. NO delegar a smiths, painter, chronicler, inspector.

### 6.4 Output del foreman (v2)

```
**Objetivo:** [1 línea]
**Exploración:** [scout/scribe/sage findings]
**Plan:**
  1. [acción] → archivos: [paths] → complejidad: N
  2. [acción] → archivos: [paths] → complejidad: N
**Persistido:** plan_id=[uuid] slug=[slug]
**Siguiente:** cambiar a craftsman en TUI → task_next_for_agent
```

---

## 7. Cambios al sistema

### 7.1 Migración v6: `original_plan_data`

| Campo | Tabla | Tipo | Comportamiento |
|-------|-------|------|----------------|
| `original_plan_data` | `plans` | `TEXT` | En `plan_create`: copiar snapshot de args como JSON |
| `original_plan_data` | `plan_tasks` | `TEXT` | En `task_create_batch`: copiar `{description, files, dependencies}` como JSON |

**Reglas:**
- `plan_create` setea `original_plan_data` al serializar los args de entrada
- `plan_approve` NO toca `original_plan_data`
- `plan_update_status` NO toca `original_plan_data`
- `archivePlan` lo incluye en markdown pero NO lo modifica
- `task_create_batch` setea `original_plan_data` por task

**Archivos afectados:**
- `src/db/schema.ts` — agregar columna vía `addColumnIfMissing` en migrations.ts (patrón v5)
- `src/db/types.ts` — agregar `originalPlanData: string | null` a Plan y PlanTask, PlanRow, TaskRow
- `src/db/plan-create.ts` — serializar `PlanCreateArgs` como `original_plan_data`
- `src/db/tasks.ts` — serializar cada task input como `original_plan_data`; warning si `tasks.length > 5`
- `src/db/plan-archive.ts` — leer y exportar `original_plan_data` en markdown archive
- `src/db/plans.ts` — `createPlan` acepta `originalPlanData`; `updatePlanStatus` / `approvePlan` NO lo sobrescriben

### 7.2 Migración v7: `plan_files`

```sql
CREATE TABLE IF NOT EXISTS plan_files (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  role TEXT,
  PRIMARY KEY (plan_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_plan_files_path ON plan_files(file_path);
```

**Comportamiento:**
- `plan_create` acepta `files: string[]` opcional → inserta con role `'input'`
- `task_create_batch` acepta `files: string[]` por task → inserta con role `'modified'`
- `plan_get` retorna `files[]` via JOIN
- `plan_search` acepta `file_path` filter opcional
- `plan_delete` CASCADE borra `plan_files`
- `archivePlan` incluye files en el markdown archive

**Archivos afectados:**
- `src/db/schema.ts` — SCHEMA_V7_SQL con CREATE TABLE
- `src/db/types.ts` — extender Plan/PlanTask con `files` array
- `src/db/plan-create.ts` — `files?: string[]` en args, insertar en plan_files
- `src/db/tasks.ts` — insertar en plan_files si `files` no vacío
- `src/db/plans.ts` — `getPlan` JOIN con plan_files
- `src/db/plan-archive.ts` — incluir files en markdown

### 7.3 Migración v8: `created_by_agent` + `executed_by_agent` + `executed_by_session`

```sql
ALTER TABLE plans ADD COLUMN created_by_agent TEXT;
ALTER TABLE plans ADD COLUMN executed_by_agent TEXT;
ALTER TABLE plans ADD COLUMN executed_by_session TEXT REFERENCES sessions(id) ON DELETE SET NULL;
```

**Comportamiento:**
- `plan_create`: setea `created_by_agent = ctx.agent` (write-once)
- `task_update_status("running")` o `plan_update_status("executing")`: setea `executed_by_agent` y `executed_by_session` si es el primer running
- `plan_approve` / `plan_update_status("completed")`: NO tocan estos campos
- `getPlan`: retorna los campos en el objeto Plan

**Archivos afectados:**
- `src/db/schema.ts` — `addColumnIfMissing` en migrations.ts
- `src/db/types.ts` — agregar `createdByAgent`, `executedByAgent`, `executedBySession` a Plan y PlanRow
- `src/db/plan-create.ts` — pasar `ctx.agent` como `createdByAgent`
- `src/db/plans.ts` — en `updatePlanStatus`, setear `executed_by_agent`/`executed_by_session` al pasar a `executing`; en `createPlan`, setear `created_by_agent`
- `src/db/plan-archive.ts` — incluir en markdown archive

### 7.4 `plan_delete` safety

**Tool:** Nuevo en `src/plugin.ts`

**Función:** `deletePlan(db, id, confirm)` en `src/db/plans.ts`

**Validaciones:**
1. `typeof confirm !== 'boolean' || confirm !== true` → error `"ndomo: plan_delete requires confirm: true"`
2. `plan.status === 'draft'` → error `"ndomo: cannot delete a draft plan — use abandonPlan or approve first"`
3. Existen tasks con `status IN ('pending', 'running')` → error `"ndomo: plan has active tasks — resolve them first"`

**Si pasa:** `DELETE FROM plans WHERE id = ?` (CASCADE: plan_tasks, plan_tags, plan_files; sessions → SET NULL)

### 7.5 Plan ≤5 steps soft warning

En `src/db/tasks.ts`, función `createTasksBatch`:

```typescript
if (tasks.length > 5) {
  console.warn(`[ndomo] plan ${planId} has ${tasks.length} tasks (>5): consider splitting`);
}
```

No bloquea. Warning visible en logs de OpenCode.

### 7.6 Caveman global en 14 agents

Insertar snippet estándar después del frontmatter YAML, antes del primer heading:

```
Tono: caveman por default, nivel full. Activa siempre.
Excepción: prosa normal para advertencias de seguridad,
acciones irreversibles o ambigüedad multi-paso.
```

**Archivos:** `agents/chronicler.md`, `agents/go-smith.md`, `agents/guild.md`, `agents/inspector.md`, `agents/js-smith.md`, `agents/painter.md`, `agents/python-smith.md`, `agents/rust-smith.md`, `agents/sage.md`, `agents/scout.md`, `agents/scribe.md`, `agents/smith.md`, `agents/vue-smith.md`, `agents/zig-smith.md`.

---

## 8. Acceptance criteria

### 8.1 Craftsman existe y es primary
- [ ] `agents/craftsman.md` existe con `mode: primary`, frontmatter completo
- [ ] Prompt cubre 4 estados con threshold 2/5/1
- [ ] User puede cambiar a craftsman en TUI

### 8.2 Threshold 2/5/1 funcional
- [ ] Estado 1: tarea ≤2 archivos → implementa sin plan_db
- [ ] Estado 2: tarea 3-5 archivos → crea plan_db + tasks
- [ ] Estado 3: plan existente → ejecuta tasks asignadas
- [ ] Estado 4: tarea >5 archivos → reporta fuera de dominio

### 8.3 Routing interno del craftsman
- [ ] Delegación por extensión: .go → go-smith, .vue → vue-smith, etc.
- [ ] `metadata.stack` override funciona
- [ ] LLM fallback a `smith` genérico

### 8.4 Painter solo vía craftsman
- [ ] Foreman NO lista painter en su routing
- [ ] Craftsman puede delegar a painter si `stack === "vue"` y `type === "design"`
- [ ] Craftsman usa vue-smith para UI no-design

### 8.5 Cross-session close
- [ ] `plan_create` setea `created_by_agent` (write-once)
- [ ] Primer `task_update_status("running")` setea `executed_by_agent` + `executed_by_session`
- [ ] Campos no se sobrescriben en updates posteriores

### 8.6 Migraciones DB
- [ ] v6: `original_plan_data` write-once en plans y plan_tasks
- [ ] v7: `plan_files` insert + query + CASCADE
- [ ] v8: `created_by_agent`, `executed_by_agent`, `executed_by_session` en plans
- [ ] Migraciones aplican limpias a DB existente

### 8.7 `plan_delete` safety
- [ ] Rechaza sin `confirm: true`
- [ ] Rechaza si `status='draft'`
- [ ] Rechaza si hay tasks pending/running
- [ ] CASCADE ejecuta correctamente

### 8.8 Plan ≤5 steps
- [ ] `agents/foreman.md` contiene regla de ≤5 steps
- [ ] `task_create_batch` emite console.warn si >5 tasks

### 8.9 Caveman global
- [ ] 14 agents tienen snippet caveman estándar
- [ ] Craftsman tiene caveman en prompt
- [ ] Foreman ya tenía caveman (no duplicar)

### 8.10 Tests y verificación
- [ ] `plan_delete` tests (3 sub-casos)
- [ ] `original_plan_data` write-once test
- [ ] `plan_files` insert + query + CASCADE test
- [ ] Audit trail write-once test (v8)
- [ ] `bun run typecheck` pasa sin errores
- [ ] `bun test` pasa (suite completa)

### 8.11 Docs
- [ ] `docs/agents.md` tiene sección craftsman (rol, cuándo usar, threshold 2/5/1)
- [ ] `docs/workflows.md` árbol de decisión actualizado

---

## 9. Plan de implementación (5 fases)

### Fase 0: Spec v2 + backup v1 (chronicler, ~30min)

**Qué:**
1. Backup `docs/features/feature-flexible-builder.md` → `-v1.md`
2. Reescribir spec v2 con arquitectura craftsman + foreman 4 pasos + threshold 2/5/1

**Archivos:**
- `docs/features/feature-flexible-builder.md` (rewrite)
- `docs/features/feature-flexible-builder-v1.md` (backup)

### Fase 1: Migraciones DB + tests (js-smith, ~2h)

**Qué:**
1. v6: `original_plan_data` en plans + plan_tasks
2. v7: `plan_files` join table
3. v8: `created_by_agent` + `executed_by_agent` + `executed_by_session`
4. `deletePlan` en `src/db/plans.ts` con safety checks
5. Tests: `plans.test.ts` (delete), `plan-files.test.ts`, `migrations-v8.test.ts`

**Archivos:** Ver sección 7.1, 7.2, 7.3, 7.4

### Fase 2: `agents/craftsman.md` (chronicler, ~1h)

**Qué:**
1. Crear `agents/craftsman.md` con frontmatter + prompt 4 estados + routing + cross-session close

**Archivos:**
- `agents/craftsman.md` (nuevo)

**Dependencia:** Phase 1 (para referencias DB en el prompt)

### Fase 3: Foreman rewrite + caveman global (smith/chronicler, ~1.5h)

**Qué:**
1. Rewrite `agents/foreman.md` a 4 pasos: Aclaración→Exploración→Plan Atómico→Persistir
2. Agregar caveman a 14 agents (diff mecánico)
3. Registrar `plan_delete` en `src/plugin.ts`
4. Soft warning ≤5 tasks en `src/db/tasks.ts`

**Archivos:**
- `agents/foreman.md` (rewrite)
- `agents/*.md` (14 archivos, +caveman)
- `src/plugin.ts` (+plan_delete tool)
- `src/db/tasks.ts` (+warning)

**Dependencia:** Phase 2 (foreman routing ya no incluye smiths)

### Fase 4: Docs + smoke tests (chronicler, ~1h)

**Qué:**
1. Actualizar `docs/agents.md` con craftsman
2. Actualizar `docs/workflows.md` con árbol de decisión
3. Smoke tests checklist (no automatizados):
   - Foreman flow 4 pasos: plan_create + task_create_batch
   - Craftsman Estado 1: ≤2 archivos, sin plan_db
   - Craftsman Estado 4: >5 archivos → rechazo
4. `bun run typecheck` y `bun test` verdes

**Archivos:**
- `docs/agents.md` (nueva sección craftsman)
- `docs/workflows.md` (árbol actualizado)

**Dependencia:** Phase 2 + Phase 3

---

## 10. Riesgos y trade-offs

### R1. Abuso del craftsman para tareas grandes

**Riesgo:** Craftsman tiene `edit: allow` + `task: allow`. El user podría usarlo para features >5 archivos, saltándose el foreman.

**Mitigación (2 capas):**
1. **Prompt:** Estado 4 rechaza explícitamente >5 archivos
2. **Modelo:** craftsman usa temperatura 0.1, menos propenso a auto-expandir scope

**Severidad:** baja (el sistema es una herramienta, no un guardián).

### R2. Separación manual foreman→craftsman confusa

**Riesgo:** El user no sabe cuándo usar foreman vs craftsman, resultando en planes mal diseñados o implementaciones sin plan.

**Mitigación:**
1. Foreman en el Paso 1 (Aclaración) sugiere craftsman si la tarea es ≤5 archivos
2. Craftsman en Estado 4 sugiere foreman si >5 archivos
3. `docs/workflows.md` documenta árbol de decisión

**Severidad:** media (curva de aprendizaje inicial).

### R3. Crecimiento de DB con `original_plan_data`

**Riesgo:** Duplica `plan_data` (2x por fila). En proyectos grandes, puede sumar MB.

**Mitigación:**
1. Auto-archive a markdown cuando el plan se completa
2. Archivar setea `archived_at`, limpiando de DB activa

**Severidad:** baja (SQLite, 1000 planes ≈ 2-5MB extra).

### R4. Write-once no enforced en DB

**Riesgo:** Los campos `created_by_agent`, `executed_by_agent`, `executed_by_session` y `original_plan_data` son write-once por convención, no por constraint DB.

**Mitigación:**
1. El código en `planCreateExecutor`, `createPlan`, `updatePlanStatus` verifica antes de setear
2. Tests unitarios validan write-once behavior

**Severidad:** baja (si se sobrescribe, es bug en el código, no en la DB).

### R5. Caveman en 14 agents = 14 lugares de mantenimiento

**Riesgo:** El snippet caveman puede volverse inconsistente si se edita en un agent y no en los otros.

**Mitigación:**
1. Snippet exacto documentado en spec (sección 7.6)
2. Si cambia, buscar/replace en 14 archivos

**Severidad:** baja (diff mecánico).

### R6. Foreman sin acceso a smiths — posible fricción

**Riesgo:** Si el user pide al foreman "implementa X en Go" y el foreman no puede delegar a go-smith directamente, el user debe cambiar manualmente a craftsman.

**Mitigación:**
1. Foreman en Paso 1 sugiere craftsman temprano
2. Foreman puede planificar y craftsman ejecuta — el user cambia una vez

**Severidad:** media-baja (un switch manual adicional vs delegación automática).

---

## 11. Referencias cruzadas

### 11.1 Archivos clave

| Archivo | Líneas relevantes | Notas |
|---------|-------------------|-------|
| `agents/foreman.md` | 1-21 (frontmatter), 162-200 (10 pasos v1) | Se reescribe a 4 pasos en Phase 3 |
| `agents/craftsman.md` | (nuevo) | Creado en Phase 2 |
| `src/db/schema.ts` | 8-497 (v1-v5), MIGRATIONS array 465-497 | Se agregan v6/v7/v8 |
| `src/db/types.ts` | 41-64 (Plan), 66-91 (PlanTask), 119-166 (Rows) | Se extienden con nuevos campos |
| `src/db/plans.ts` | createPlan, updatePlanStatus, approvePlan | Puntos de inserción original_plan_data + v8 |
| `src/db/tasks.ts` | 13-80 (createTasksBatch), 109-121 (truncation) | original_plan_data + warning ≤5 |
| `src/db/plan-create.ts` | 15-30 (PlanCreateArgs), 32-62 (planCreateExecutor) | ensureSession ya existe |
| `src/db/plan-archive.ts` | serializePlanToMarkdown, archivePlan | Incluir nuevos campos |
| `src/db/migrations.ts` | addColumnIfMissing, runMigrations | Patrón para v6/v7/v8 |
| `src/plugin.ts` | 352-822 (tools) | Nuevo tool plan_delete + adjust plan_create |
| `src/db/plans.ts` | (nueva función) | deletePlan con safety checks |
| `docs/bugs/plan-create-orphan-fk.md` | 60-70, 88-103 | Bug conocido, no resuelto |

### 11.2 Specs relacionados

| Recurso | Relación |
|---------|----------|
| `docs/features/feature-flexible-builder-v1.md` | Spec original v1 (archivada). Define `builder` con 3 estados. Reemplazada por v2. |
| `agents/foreman.md` | Prompt actual del foreman (10 pasos). Se reescribe en Phase 3. |
| `docs/agents.md` | Se actualiza en Phase 4 con craftsman. |
| `docs/workflows.md` | Se actualiza en Phase 4 con árbol de decisión. |
| `src/db/schema.ts` | Schema DB actual (v1-v5). Migraciones v6+v7+v8 en spec. |

### 11.3 Árbol de decisión actualizado

```
User envía prompt
  │
  ├─ ¿Tarea ≤2 archivos, ≤50 líneas, bien definida?
  │   → `craftsman` en TUI → Estado 1 (trivial, sin plan_db)
  │
  ├─ ¿Tarea 3-5 archivos, multi-stack, necesita tracking?
  │   → `craftsman` en TUI → Estado 2 (ad-hoc con plan_db)
  │
  ├─ ¿Tarea >5 archivos, diseño de arquitectura, o ambigua?
  │   → `foreman` en TUI → 4 pasos: Aclaración → Exploración → Plan → Persistir
  │   → Luego `craftsman` en TUI → Estado 3 (lee plan formal)
  │
  ├─ ¿Auditoría de PR existente o tarea read-only?
  │   → `craftsman` o `scout` según necesite escribir
  │
  └─ ¿Exploración read-only?
      → `scout` en TUI
```

---

## Apéndice A: Decisiones del grill

| Decisión | Opción elegida | Alternativas descartadas |
|----------|---------------|--------------------------|
| Nombre del primary | `craftsman` | `builder` (v1), `implementer`, `artisan` |
| Threshold | 2/5/1 (≤2 Estado 1, 3-5 Estado 2, >5 Estado 4) | 1/2-5 (v1), 1/3-5/6+ |
| Estados del craftsman | 4 (trivial / multi-archivo / plan formal / fuera dominio) | 3 (v1) |
| Foreman pasos | 4 (Aclaración / Exploración / Plan / Persistir) | 10 (v1), 6, 3 |
| Painter routing | Solo craftsman | Foreman + craftsman |
| Cross-session close | `created_by_agent` + `executed_by_agent` + `executed_by_session` | Solo `created_by` |
| `plan_delete` fase | Phase 1 (priorizada) | Phase 3 (v1) |
| Plan ≤5 steps | Soft warning (no bloqueo) | Bloqueo estricto |
| Caveman snippet | Estándar en 14 agents | Caveman solo en prompt |

---

## Apéndice B: Relación con bugs existentes

### Bug `ctx.sessionID` (`docs/bugs/plan-create-orphan-fk.md`)

No se resuelve en este spec. Craftsman usa `plan_create` + `plan_update_status("completed")`:
- `planCreateExecutor` ya tiene `ensureSession` automático (`src/db/plan-create.ts:39-41`)
- `planUpdateStatus` solo chequea FK para status `executing`/`approved` (`src/db/plans.ts:122`)
- Craftsman no usa `plan_approve`

**Impacto:** El bug no afecta al flujo craftsman.

### Truncation 16KB (`src/db/tasks.ts:109-121`)

No se resuelve en este spec. Craftsman genera resultados pequeños (formato caveman). Si un sub-smith produce output grande, el truncation aplica igual que hoy.

---

*Fin del feature spec v2 — ~600 líneas*

# Feature: Primary Craftsman — refactor arquitectónico (v3)

**Slug:** `feature-flexible-builder`
**Status:** Implemented (spec v3, post-merge)
**Plan ID:** `b90682bb-3d75-4a03-8042-8ac350910b53`
**Plan slug:** `flexible-builder-v3-lows`
**Created:** 2026-06-20
**Supersedes:** `docs/features/feature-flexible-builder-v2.md`

---

## Diff vs v2

Novedades incorporadas en esta spec v3 respecto a v2:

- **Nuevo: `task_escalate` MCP tool** — craftsman escala tareas complejas al foreman creando un plan stub con metadata de escalation (`src/plugin.ts:941-963`)
- **Nuevo: `session_end` reconcile hook** — al marcar sesión como terminada, planes `executing`/`approved` sin cerrar pasan a `abandoned` (`src/plugin.ts:1004-1014`)
- **Nuevo: Parallel dispatch rule** — threshold >3 archivos o multi-stack o >100 líneas diff → split en sub-tasks paralelos (`agents/craftsman.md:170`)
- **Nuevo: Parallel retry policy** — retry-1-then-isolate por defecto; ≥2/N fails → fail-fast (`agents/craftsman.md:97-99`)
- **Nuevo: Trivium craftsman self-edit** — ≤10 líneas, 1 archivo, 0 nuevos exports, 0 behavior changes (`agents/craftsman.md:200-210`)
- **Nuevo: plan_files multi-role consideration** — PK (plan_id, file_path) impide multi-role por file; pendiente de resolver en Fase 3 (L7) del plan v3
- **Migración v9 implementada** — `plan_progress` view fix para excluir archived plans (`src/db/schema.ts:507-529`)
- **Todas las migraciones** v6/v7/v8/v9 marcadas como **IMPLEMENTED**
- **Write-once enforcement** actualizado de "por convención" a "validado en código + tests"
- **Árbol de decisión** extendido con rutas `task_escalate` y dispatch paralelo
- **Sección 7** revisada: v6/v7/v8 IMPLEMENTED, v9 agregado, task_escalate y session_end hook documentados

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

| Aspecto | v1 (`builder`) | v2/v3 (`craftsman`) |
|---------|----------------|---------------------|
| Nombre | `builder` | `craftsman` (confirmado en grill) |
| Estados | 3 (trivial, ad-hoc, formal) | 4 (con threshold 2/5/1) |
| Threshold archivos | 1 / 2-5 / >5 | ≤2 Estado 1, 3-5 Estado 2, >5 Estado 4 |
| Foreman | Sin cambios (10 pasos) | Simplificado a 4 pasos (planner puro) |
| Cross-session close | `created_by` básico | `executed_by_agent` + `executed_by_session` + `created_by_agent` |
| Migraciones DB | v6 + v7 | v6 (original_plan_data) + v7 (plan_files) + v8 (agent/session audit) + v9 (view fix) |
| Painter routing | Foreman | Solo craftsman |
| Caveman | 14 agents target | Mismos 14 + snippet estándar |
| `plan_delete` | Fase 3 | Fase 1 (priorizada) — **IMPLEMENTED** |
| Plan ≤5 steps | Soft warning | Soft warning + log |
| `task_escalate` | No existe | MCP tool — **IMPLEMENTED** |
| `session_end` reconcile | No existe | Hook automático — **IMPLEMENTED** |
| Parallel dispatch | No existe | Threshold >3 archivos/multi-stack — **IMPLEMENTED** |
| Trivium self-edit | Solo foreman | Craftsman ≤10 líneas, 1 file, 0 exports — **IMPLEMENTED** |

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

### 3.2 Tabla comparativa ndomo-v1 vs nicosup98/ndomo vs ndomo-v3

| Aspecto | ndomo-v1 (foreman 10 pasos) | nicosup98/ndomo | ndomo-v3 (craftsman + foreman 4 pasos) |
|---------|-----------------------------|-----------------|----------------------------------------|
| Default agent | foreman (primary) | `build` (built-in) | foreman (primary planner) |
| Implementador | foreman delega a smiths | builder/scout/qagent | **craftsman** (primary implementer) |
| Modo trivial | Trivium ≤5 líneas + plan_db | `build` single-turn | Craftsman Estado 1 (sin plan_db) |
| Modo plan formal | foreman → 10 pasos → smiths | architect → plan_db → builder | Foreman 4 pasos → plan_db → craftsman |
| Coordinación | `task` síncrono | `plan_db` async + TUI switch | `plan_db` async + TUI switch |
| Audit trail | Solo `created_at`/`updated_at` | `original_plan_data` | `original_plan_data` + agent/session FK |
| Plan↔file | No existe | `plan_files` | `plan_files` |
| Tono global | Caveman parcial (foreman + algunos) | Caveman en TODOS | Caveman en TODOS los 14 + craftsman |
| `plan_delete` | No existe | Rechaza si `status='pending'` | Safety 3-capas — **IMPLEMENTED** |
| Plan ≤5 steps | No hay regla | Regla en architect.md | Soft warning en task_create_batch |
| Auto-escalation | No existe | No existe | **`task_escalate`** MCP tool — craftsman→foreman |
| Session reconcile | No existe | No existe | **`session_end` hook** — abandon planes on session end |
| Dispatch paralelo | No existe | No existe | **Parallel sub-tasks** >3 files/multi-stack |
| Self-edit trivium | No existe | No existe | **≤10 lines, 1 file, 0 exports** — craftsman |

### 3.3 Por qué el patrón async + user switch gana

Modelo v1 (foreman 10 pasos):
1. Foreman crea plan en DB (2 writes)
2. Foreman crea tasks batch (N writes)
3. Foreman llama `task` para cada smith (N LLM invocations)
4. Foreman espera resultados (N context switches)
5. Foreman reconcilia resultados (N reads)

Modelo v3 (foreman 4 pasos + craftsman):
1. Foreman crea plan en DB (1-2 writes) — solo si >5 archivos o diseño arquitectura
2. User cambia a craftsman en TUI (0 LLM tokens)
3. Craftsman lee plan y ejecuta (1 read + N writes)
4. Craftsman cierra plan con `plan_update_status("completed")`

**Diferencia clave:** El modelo v3 gasta ~60% menos tokens en coordinación porque el "router" (foreman) solo escribe a DB, no invoca LLMs secundarios. Craftsman opera autónomamente.

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

**Diferencia con v1:** v1 proponía 1/2-5 con threshold 1 archivo para Estado 1. v3 sube a ≤2 archivos para Estado 1, reflejando que fixes de 2 archivos son comunes y no requieren plan_db.

**Enforcement:** Solo por prompt (no hay validación en código). Craftsman es un primary agent; su prompt es la única barrera.

### D3. Routing interno: `task.files` extensión + `metadata.stack`

**Decisión:** El craftsman decide a qué sub-agente delegar basándose en (1) extensión de archivo en `task.files`, (2) `task.metadata.stack` si existe, (3) LLM fallback.

| Extensión / Contexto | Sub-agente |
|----------------------|------------|
| `.go` | `go-smith` |
| `.vue`, `.svelte` | `vue-smith` |
| `.ts`, `.tsx`, `.js`, `.jsx` | `js-smith` |
| `.py` | `python-smith` |
| `.rs` | `rust-smith` |
| `.zig` | `zig-smith` |
| UI/design + `type=design` | `painter` |
| Documentación / markdown | `chronicler` |
| Auditoría / seguridad / diff review | `inspector` |
| Exploración read-only / mapeo | `scout` |
| Investigación APIs / docs externas | `scribe` |
| Sin match | `smith` (genérico stack-agnostic) |

**Archivo:** `agents/craftsman.md` — tabla de routing interno (`agents/craftsman.md:151-164`).

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
- Write-once: verificación en código antes de setear

### D6. `plan_delete` en Phase 1 (priorizada) — IMPLEMENTED

**Decisión:** `plan_delete` tool se implementa en Phase 1 (no Phase 3 como en v1).

**Safety checks** (`src/db/plans.ts:312-339`):
1. `confirm !== true` → error
2. `plan.status === 'draft'` → error (usar abandonPlan o approve primero)
3. Existen tasks `pending` o `running` → error
4. CASCADE: borra plan_tasks, plan_tags, plan_files (sessions → SET NULL)

**Archivo:** `src/plugin.ts:756-766` (tool registration), `src/db/plans.ts:312-339` (core function)

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

### 5.1 Frontmatter YAML (IMPLEMENTED — `agents/craftsman.md:1-42`)

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
    "inspector": allow
    "chronicler": allow
  plan_db: allow
---
```

**Diferencias con el foreman:**
- `mode: primary` (NO subagent)
- `task` permitido a subagents implementadores + painter + chronicler + inspector
- `task` NO permitido a foreman, guild, sage (son planners/advisors)
- Permisos `edit: allow`, `bash: ask` (craftsman implementa; foreman solo planifica)
- `plan_db` tools disponibles pero condicionales (Estado 1 no las usa)

### 5.2 Prompt con 4 estados (IMPLEMENTED)

El prompt completo está en `agents/craftsman.md:44-249`. Resumen de cada estado:

| Estado | Condición | Flujo |
|--------|-----------|-------|
| Estado 1: Trivial | ≤2 archivos, ≤50 líneas diff, sin dependencias | Implementa directo, NO plan_db |
| Estado 2: Multi-archivo | 3-5 archivos, multi-stack, necesita tracking | Crea plan_db propio + tasks |
| Estado 3: Plan formal | Plan foreman existente con tasks para craftsman | Lee plan_get/task_next, ejecuta TDD |
| Estado 4: Fuera dominio | >5 archivos o requiere diseño arquitectura | Rechaza, sugiere foreman |

### 5.3 Trivium self-edit (NUEVO en v3)

Cuando craftsman edita código directamente (sin delegar a sub-smith), aplica trivium (`agents/craftsman.md:200-210`):

- **≤10 líneas modificadas** por self-edit individual
- **1 archivo máximo** por self-edit
- **0 funciones/exports nuevos**
- **0 cambios de comportamiento** (typos, renombres mecánicos, imports faltantes)
- **Verificar post-escritura**: `bun run typecheck` + `bun test` del scope afectado

**Default:** cualquier cambio >10 líneas o >1 archivo → delegar a sub-smith.

### 5.4 Parallel dispatch rule (NUEVO en v3)

Reglas de routing para dispatch paralelo (`agents/craftsman.md:166-171`):

- Si `task.metadata.stack` existe y es explícito → override (no mirar extensión)
- Si no hay match por extensión ni stack → usar `smith` (genérico)
- Si la tarea toca **múltiples stacks** → dividir en sub-tasks, una por stack
- **Tareas grandes → dispatch paralelo**: >3 archivos o multi-stack o >100 líneas diff → dividir en sub-tasks (1 por stack/chunk), dispatchar todas en paralelo vía `task`, esperar a TODAS antes de cerrar el plan
- NO delegar a: foreman, sage, guild

**Anti-patterns:**
- ❌ 5 archivos a 1 solo smith
- ❌ Todo al `smith` genérico
- ❌ Serial cuando se podría paralelizar

### 5.5 Parallel retry policy (NUEVO en v3)

Política de reintentos para sub-tasks paralelos (`agents/craftsman.md:97-99`):

| Escenario | Comportamiento |
|-----------|---------------|
| Default | `retry-1-then-isolate` |
| 1/N falla | Retry 1 vez; si reintento falla → `task_update_status("failed")` + continue-isolated (resto sigue) |
| ≥2/N fallan | Fail-fast: cancelar dispatch pendiente, `plan_update_status("failed")` |
| Timeout >5min | Tratado como failed |
| Override | `metadata.parallelRetryPolicy: "no-retry" \| "fail-fast" \| "continue-isolated"` |

### 5.6 Cross-session close (IMPLEMENTED)

Al cerrar planes (`agents/craftsman.md:173-180`):
- `executed_by_agent`: siempre `"craftsman"`
- `executed_by_session`: siempre `current_session_id` (ctx.sessionID)
- `created_by_agent`: setear en `plan_create` si craftsman creó el plan (Estado 2)
- Write-once enforcement: verificación en código antes de setear

### 5.7 Routing extendido (IMPLEMENTED)

Tabla de routing actual (`agents/craftsman.md:151-164`) incluye:
- go-smith, vue-smith, js-smith, python-smith, rust-smith, zig-smith
- painter (UI/design), chronicler (docs), inspector (audit), scout (explore), scribe (research)
- `smith` genérico como fallback

---

## 6. Foreman nuevo flow: 4 pasos (planner puro) — IMPLEMENTED

### 6.1 Comparativa 10 pasos → 4 pasos

| v1 (10 pasos) | v3 (4 pasos) | Diferencia |
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

**Archivo:** `agents/foreman.md:121-152`

### 6.2 Flujo detallado

#### Paso 1: Aclaración
- Identificar intención en 1-2 frases
- Si ambigüedad: `question` al usuario
- Si la tarea es ≤5 archivos y bien definida → sugerir `craftsman`
- Si >5 archivos o requiere diseño → continuar con planificación

#### Paso 2: Exploración
- `memory({mode:"search", scope:"project"})` — decisiones pasadas
- `memory({mode:"search", scope:"all-projects"})` — conocimiento cross-proyecto
- Delegar a subagentes según necesidad:
  - `scout` — mapear repo, encontrar archivos, detectar stack
  - `scribe` — investigar APIs, versiones, docs externas
  - `sage` — evaluar trade-offs arquitectónicos, debugging
  - `guild` — solo si usuario pide debate explícito
- NO delegar a smiths, painter, chronicler, inspector

#### Paso 3: Plan Atómico
- Desglosar en ≤5 steps top-level
- Cada step: `(Acción) → archivos esperados [paths] → dependencias`
- Estimar complejidad (1-5) y riesgo (low/medium/high)

#### Paso 4: Persistir
- `plan_create` con slug, overview, approach, priority
- `task_create_batch` con steps (tasks para craftsman)
- NO crear `session_start` (lo hace craftsman al ejecutar)
- NO ejecutar tasks — craftsman las toma via `task_next_for_agent`

### 6.3 Routing table del foreman (`agents/foreman.md:45-56`)

| Petición | Delegar a |
|----------|-----------|
| Explorar código / mapear repo | `scout` |
| Investigar APIs / docs / versiones | `scribe` |
| Arquitectura / trade-offs / debugging difícil | `sage` |
| Debate multi-perspectiva | `guild` (solo manual) |

NOTA: foreman solo planifica. Ejecución es craftsman. NO delegar a smiths, painter, chronicler, inspector.

### 6.4 Output del foreman

```
**Objetivo:** [1 línea]
**Exploración:** [findings de scout/scribe/sage]
**Plan:**
  1. [acción] → archivos: [paths] → complejidad: N
  2. [acción] → archivos: [paths] → complejidad: N
**Persistido:** plan_id=[uuid] slug=[slug]
**Siguiente:** cambiar a craftsman en TUI → task_next_for_agent
**Estatus:** [Planificado | Bloqueado: <razón> | Craft-sugerido]
```

### 6.5 Plan Approve (legacy)

`plan_approve` es un tool MCP registrado en `src/plugin.ts` que marca un plan como `approved` seteando `approved_at`.

**Estado:** **LEGACY** — El flujo v3 de foreman (4 pasos) **NO usa `plan_approve`**. Foreman pasa directo de `plan_create` (status `draft`) a `task_create_batch`.

**Archivo:** `src/plugin.ts:621-632` (tool registration original, líneas aproximadas — verificar offset actual)

---

## 7. Cambios al sistema

### 7.1 Migración v6: `original_plan_data` — IMPLEMENTED

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

**Archivos:** `src/db/schema.ts:467-473`, `src/db/types.ts`, `src/db/plan-create.ts`, `src/db/tasks.ts`, `src/db/plan-archive.ts`, `src/db/plans.ts`

**Esquema:** Columnas agregadas vía `addColumnIfMissing()` en migrations.ts (`src/db/schema.ts:472-473`).

### 7.2 Migración v7: `plan_files` — IMPLEMENTED

```sql
CREATE TABLE IF NOT EXISTS plan_files (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'input',
  PRIMARY KEY (plan_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_plan_files_plan ON plan_files(plan_id);
```

**Comportamiento:**
- `plan_create` acepta `files: string[]` opcional → inserta con role `'input'`
- `task_create_batch` acepta `files: string[]` por task → inserta con role `'modified'`
- `plan_get` retorna `files[]` via JOIN
- `plan_search` acepta `file_path` filter opcional
- `plan_delete` CASCADE borra `plan_files`
- `archivePlan` incluye files en el markdown archive

**Archivos:** `src/db/schema.ts:480-488`, `src/db/types.ts`, `src/db/plan-create.ts`, `src/db/tasks.ts`, `src/db/plans.ts`, `src/db/plan-archive.ts`

**Tests:** `src/db/plan-files.test.ts`

### 7.3 Migración v8: `created_by_agent` + `executed_by_agent` + `executed_by_session` — IMPLEMENTED

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

**Archivos:** `src/db/schema.ts:497-498`, `src/db/types.ts`, `src/db/plan-create.ts`, `src/db/plans.ts`, `src/db/plan-archive.ts`

**Tests:** `src/db/migrations-v8.test.ts`

### 7.4 Migración v9: `plan_progress` view fix — IMPLEMENTED

**Problema:** DBs con schema_version ≥5 que ya tenían la view `plan_progress` antes del fix nunca re-ejecutaron v5, manteniendo la view antigua sin filtro `archived_at`.

**Solución:** DROP + CREATE de `plan_progress` view con filtro `WHERE p.archived_at IS NULL` (`src/db/schema.ts:507-529`).

```sql
DROP VIEW IF EXISTS plan_progress;
CREATE VIEW plan_progress AS
SELECT
  p.id AS plan_id,
  p.slug, p.title, p.status,
  COUNT(t.id) AS total_tasks,
  SUM(CASE WHEN t.status = 'done'     THEN 1 ELSE 0 END) AS done,
  SUM(CASE WHEN t.status = 'failed'   THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN t.status = 'running'  THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN t.status = 'pending'  THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN t.status = 'blocked'  THEN 1 ELSE 0 END) AS blocked,
  CASE
    WHEN COUNT(t.id) = 0 THEN 0
    ELSE ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id))
  END AS progress_pct
FROM plans p
LEFT JOIN plan_tasks t ON t.plan_id = p.id AND t.archived_at IS NULL
WHERE p.archived_at IS NULL
GROUP BY p.id;
```

### 7.5 `plan_delete` safety — IMPLEMENTED

**Tool** en `src/plugin.ts:756-766`.

**Función:** `deletePlan(db, id, confirm)` en `src/db/plans.ts:312-339`.

**Validaciones:**
1. `typeof confirm !== 'boolean' || confirm !== true` → error `"ndomo: deletePlan requires confirm: true"`
2. `plan.status === 'draft'` → error `"ndomo: cannot delete a draft plan — use abandonPlan or approve first"`
3. Existen tasks con `status IN ('pending', 'running')` → error `"ndomo: plan has active tasks — resolve them first"`

**Si pasa:** `DELETE FROM plans WHERE id = ?` (CASCADE: plan_tasks, plan_tags, plan_files; sessions → SET NULL)

**Tests:** `src/db/plans.test.ts:160-234` (4 sub-casos: success, draft rejection, active tasks rejection, missing confirm)

### 7.6 Plan ≤5 steps soft warning — IMPLEMENTED

En `src/db/tasks.ts`, función `createTasksBatch`:

```typescript
if (tasks.length > 5) {
  console.warn(`[ndomo] plan ${planId} has ${tasks.length} tasks (>5): consider splitting`);
}
```

No bloquea. Warning visible en logs de OpenCode.

### 7.7 Caveman global en 14 agents — IMPLEMENTED

Snippet estándar insertado después del frontmatter YAML en 14 archivos (`agents/chronicler.md:16`, `agents/go-smith.md:32`, `agents/guild.md:28`, `agents/inspector.md:28`, `agents/js-smith.md:32`, `agents/painter.md:32`, `agents/python-smith.md:32`, `agents/rust-smith.md:32`, `agents/sage.md:28`, `agents/scout.md:28`, `agents/scribe.md:28`, `agents/smith.md:32`, `agents/vue-smith.md:32`, `agents/zig-smith.md:32`).

```
Tono: caveman por default, nivel full. Activa siempre.
Excepción: prosa normal para advertencias de seguridad,
acciones irreversibles o ambigüedad multi-paso.
```

### 7.8 `task_escalate` MCP tool (NUEVO en v3) — IMPLEMENTED

**Tool registration:** `src/plugin.ts:941-963`

```typescript
task_escalate: tool({
  description:
    "Escalar tarea compleja al foreman. Crea un plan stub (foreman) con " +
    "metadata.escalatedFrom=<planId_or_null> + metadata.escalatedBy='craftsman' " +
    "y notifica via session_checkpoint. NO ejecuta código.",
  args: {
    sourcePlanId: tool.schema.string().optional(),
    sourceTaskId: tool.schema.string().optional(),
    reason: tool.schema.string(),
    suggestedApproach: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    if (!args.reason || args.reason.trim().length === 0) {
      throw new Error("ndomo: task_escalate requires a non-empty reason");
    }
    // ... calls escalateToForeman(db, ctx, escalateArgs)
  },
}),
```

**Core function:** `escalateToForeman()` en `src/plugin.ts:85-149`:

1. Crea plan stub con metadata `{ escalatedFrom, escalatedBy: "craftsman", reason }`
2. Si `sourceTaskId` existe, crea una task foreman en el plan de escalation
3. Hace `session_checkpoint` con nota de escalation

**Cuándo craftsman lo usa:** Cuando una tarea excede el dominio del craftsman (Estado 4) o encuentra una dependencia que requiere planificación foreman. Craftsman no invoca `task_escalate` directamente como tool MCP — el prompt del craftsman documenta que debe reportar `[FUERA DE MI DOMINIO]` y sugerir cambiar a foreman. El tool existe para uso programático/automatizado.

### 7.9 `session_end` reconcile hook (NUEVO en v3) — IMPLEMENTED

**Tool registration:** `src/plugin.ts:1004-1014`

```typescript
session_end: tool({
  description:
    "Mark a session as ended. Sets ended_at. Reconciliación: planes con " +
    "status='executing' o 'approved' sin cerrar en esta session → 'abandoned' " +
    "con metadata.reason='session_ended'.",
  // ...
  execute: async (args, ctx) => {
    const plansAbandoned = reconcileAbandonedPlans(db, args.id, ctx.agent ?? "unknown");
    // ... mark session as ended
  },
}),
```

**Core function:** `reconcileAbandonedPlans()` en `src/plugin.ts:160-190`:

- Busca planes con `status IN ('executing', 'approved')` y `session_id = sessionId`
- Marca cada plan como `abandoned` con `metadata.reason = "session_ended"` + `endedBy`
- Retorna count de planes reconciliados

**Tests:** `src/plugin.test.ts:146-287` (7 sub-casos)

### 7.10 plan_files multi-role PK consideration (NUEVO en v3) — PENDING

**Problema:** La tabla `plan_files` tiene PK `(plan_id, file_path)` (`src/db/schema.ts:481-486`). Esto impide que un mismo archivo tenga múltiples roles (ej. ser `'input'` Y `'modified'` en el mismo plan). Si craftsman lee un archivo como input y luego lo modifica, el segundo INSERT con mismo `(plan_id, file_path)` pero diferente `role` falla por PK duplication.

**Estado actual:** `role` tiene default `'input'`. `plan_create` inserta con role `'input'`, `task_create_batch` inserta con role `'modified'`. Si el mismo archivo aparece en ambos, el segundo INSERT falla.

**Resolución:** Pendiente — tracking como L7 (Fase 3 del plan v3 `flexible-builder-v3-lows`). Posibles soluciones:
- Cambiar PK a `(plan_id, file_path, role)` — permite multi-role
- Usar ON CONFLICT REPLACE — pierde el role original
- Usar array/tags en `role` en lugar de string único

**Links:** `docs/features/feature-flexible-builder.md` (esta sección), plan v3 Fase 3.

---

## 8. Acceptance criteria

### 8.1 Craftsman existe y es primary — ✅ DONE
- [x] `agents/craftsman.md` existe con `mode: primary`, frontmatter completo (`agents/craftsman.md:1-42`)
- [x] Prompt cubre 4 estados con threshold 2/5/1 (`agents/craftsman.md:44-130`)
- [x] User puede cambiar a craftsman en TUI

### 8.2 Threshold 2/5/1 funcional
- [x] Estado 1: tarea ≤2 archivos → implementa sin plan_db (prompt line 58)
- [x] Estado 2: tarea 3-5 archivos → crea plan_db + tasks (prompt line 72)
- [x] Estado 3: plan existente → ejecuta tasks asignadas (prompt line 103)
- [x] Estado 4: tarea >5 archivos → reporta fuera de dominio (prompt line 123)

### 8.3 Routing interno del craftsman — ✅ DONE
- [x] Delegación por extensión: .go → go-smith, .vue → vue-smith, etc. (`agents/craftsman.md:151-164`)
- [x] `metadata.stack` override funciona (`agents/craftsman.md:167`)
- [x] LLM fallback a `smith` genérico (`agents/craftsman.md:164`)

### 8.4 Painter solo vía craftsman — ✅ DONE
- [x] Foreman NO lista painter en su routing (`agents/foreman.md:45-56`)
- [x] Craftsman puede delegar a painter si `type === "design"` (`agents/craftsman.md:159`)
- [x] Craftsman usa vue-smith para UI no-design

### 8.5 Cross-session close — ✅ DONE
- [x] `plan_create` setea `created_by_agent` (write-once)
- [x] Primer `task_update_status("running")` setea `executed_by_agent` + `executed_by_session`
- [x] Campos no se sobrescriben en updates posteriores

### 8.6 Migraciones DB — ✅ DONE
- [x] v6: `original_plan_data` write-once en plans y plan_tasks (`src/db/schema.ts:467-473`)
- [x] v7: `plan_files` insert + query + CASCADE (`src/db/schema.ts:480-488`)
- [x] v8: `created_by_agent`, `executed_by_agent`, `executed_by_session` en plans (`src/db/schema.ts:497-498`)
- [x] v9: `plan_progress` view fix — exclude archived plans (`src/db/schema.ts:507-529`)
- [x] Migraciones aplican limpias a DB existente

### 8.7 `plan_delete` safety — ✅ DONE
- [x] Rechaza sin `confirm: true` (`src/db/plans.ts:314-315`)
- [x] Rechaza si `status='draft'` (`src/db/plans.ts`)
- [x] Rechaza si hay tasks pending/running (`src/db/plans.ts`)
- [x] CASCADE ejecuta correctamente

### 8.8 Plan ≤5 steps — ✅ DONE
- [x] `agents/foreman.md` contiene regla de ≤5 steps (foreman.md:141)
- [x] `task_create_batch` emite console.warn si >5 tasks

### 8.9 Caveman global — ✅ DONE
- [x] 14 agents tienen snippet caveman estándar (chronicler, go-smith, guild, inspector, js-smith, painter, python-smith, rust-smith, sage, scout, scribe, smith, vue-smith, zig-smith)
- [x] Craftsman tiene caveman en prompt (`agents/craftsman.md:247-249`)
- [x] Foreman ya tenía caveman (no duplicar)

### 8.10 Tests y verificación — ✅ DONE (158 baseline)
- [x] `plan_delete` tests (4 sub-casos) (`src/db/plans.test.ts:160-234`)
- [x] `original_plan_data` write-once test
- [x] `plan_files` insert + query + CASCADE test (`src/db/plan-files.test.ts`)
- [x] Audit trail write-once test (v8) (`src/db/migrations-v8.test.ts`)
- [x] `task_escalate` tests (M2) (`src/plugin.test.ts:26-152`)
- [x] `session_end` reconcile tests (M3) (`src/plugin.test.ts:146-287`)
- [x] `bun run typecheck` pasa sin errores
- [x] `bun test` pasa (158 tests baseline)

### 8.11 Docs
- [x] `docs/agents.md` tiene sección craftsman (rol, cuándo usar, threshold 2/5/1)
- [x] `docs/workflows.md` árbol de decisión actualizado

### 8.12 `task_escalate` — ✅ DONE
- [x] MCP tool registrado en `src/plugin.ts:941-963`
- [x] Core function `escalateToForeman()` en `src/plugin.ts:85-149`
- [x] Crea plan stub con metadata de escalation
- [x] Session checkpoint con nota de escalation
- [x] Tests en `src/plugin.test.ts`

### 8.13 `session_end` reconcile — ✅ DONE
- [x] MCP tool registrado en `src/plugin.ts:1004-1014`
- [x] Core function `reconcileAbandonedPlans()` en `src/plugin.ts:160-190`
- [x] Abandona planes `executing`/`approved` al terminar sesión
- [x] Tests en `src/plugin.test.ts`

### 8.14 Parallel dispatch rule — ✅ DONE
- [x] Documentado en `agents/craftsman.md:170`
- [x] Threshold >3 archivos o multi-stack o >100 líneas diff → split + parallel
- [x] Anti-patterns listados

### 8.15 Parallel retry policy — ✅ DONE
- [x] Documentado en `agents/craftsman.md:97-99`
- [x] Default: retry-1-then-isolate
- [x] ≥2/N fails → fail-fast
- [x] Timeout >5min → failed
- [x] Override via `metadata.parallelRetryPolicy`

### 8.16 Trivium craftsman self-edit — ✅ DONE
- [x] Documentado en `agents/craftsman.md:200-210`
- [x] ≤10 líneas modificadas por self-edit
- [x] 1 archivo máximo
- [x] 0 funciones/exports nuevos
- [x] 0 cambios de comportamiento
- [x] Verificación post-escritura: typecheck + test
- [x] Default: >10 líneas o >1 archivo → delegar a sub-smith

### 8.17 plan_files multi-role — ⏳ PENDING (L7, Fase 3 v3 plan)
- [ ] PK `(plan_id, file_path)` impide multi-role por file
- [ ] Resolución pendiente en Fase 3 de `flexible-builder-v3-lows`

---

## 9. Plan de implementación (histórico)

El plan original de 5 fases fue ejecutado en el plan v2 y completado. Este spec v3 documenta el estado post-merge.

### Fase 0: Spec v2 + backup v1 — ✅ COMPLETED

### Fase 1: Migraciones DB + tests — ✅ COMPLETED
- v6, v7, v8, v9 migrations — ALL IMPLEMENTED
- `deletePlan` con safety checks — IMPLEMENTED
- Tests para delete, plan-files, migrations-v8 — ALL PASSING

### Fase 2: `agents/craftsman.md` — ✅ COMPLETED
- 249 lines, frontmatter + prompt 4 estados + routing extendido + trivium self-edit + parallel dispatch + retry policy

### Fase 3: Foreman rewrite + caveman global — ✅ COMPLETED
- `agents/foreman.md` rewrite a 4 pasos (286 lines)
- Caveman snippet en 14 agents
- `plan_delete` en `src/plugin.ts`
- Soft warning ≤5 tasks en `src/db/tasks.ts`

### Fase 4: Docs + smoke tests — ✅ COMPLETED
- `docs/agents.md` actualizado con craftsman
- `docs/workflows.md` árbol de decisión actualizado
- 158 tests baseline, typecheck + test verdes

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

### R4. Write-once enforcement en código + tests

**Riesgo original v2:** Los campos write-once eran solo por convención, no por constraint DB.

**Mitigación v3 (implementada):**
1. El código en `planCreateExecutor`, `createPlan`, `updatePlanStatus` verifica antes de setear
2. Tests unitarios validan write-once behavior (`src/db/migrations-v8.test.ts`)
3. Migración v8 ejecuta `addColumnIfMissing` — idempotente

**Severidad:** baja (validado en código y tests).

### R5. Caveman en 14 agents = 14 lugares de mantenimiento

**Riesgo:** El snippet caveman puede volverse inconsistente si se edita en un agent y no en los otros.

**Mitigación:**
1. Snippet exacto documentado en spec (sección 7.7)
2. Si cambia, buscar/replace en 14 archivos

**Severidad:** baja (diff mecánico).

### R6. Foreman sin acceso a smiths — posible fricción

**Riesgo:** Si el user pide al foreman "implementa X en Go" y el foreman no puede delegar a go-smith directamente, el user debe cambiar manualmente a craftsman.

**Mitigación:**
1. Foreman en Paso 1 sugiere craftsman temprano
2. Foreman puede planificar y craftsman ejecuta — el user cambia una vez

**Severidad:** media-baja (un switch manual adicional vs delegación automática).

### R7. `task_escalate` sin uso directo en prompt

**Riesgo:** El tool `task_escalate` existe como MCP tool pero el prompt del craftsman no lo invoca — en su lugar craftsman reporta `[FUERA DE MI DOMINIO]` y sugiere cambio manual a foreman.

**Impacto:** El tool está disponible para uso programático/automatizado pero no forma parte del flujo normal craftsman→foreman. Si en el futuro se quiere escalation automática, el prompt del craftsman debe actualizarse para usar `task_escalate`.

**Severidad:** baja (el tool funciona; falta integración en el prompt).

---

## 11. Referencias cruzadas

### 11.1 Archivos clave

| Archivo | Líneas relevantes | Estado |
|---------|-------------------|--------|
| `agents/foreman.md` | 1-286 (completo) | **IMPLEMENTED** — 4 pasos planner puro |
| `agents/craftsman.md` | 1-249 (completo) | **IMPLEMENTED** — 4 estados + routing + trivium |
| `src/db/schema.ts` | 467-583 (MIGRATIONS v6-v9) | **IMPLEMENTED** |
| `src/db/types.ts` | Plan, PlanTask, PlanRow, TaskRow | **IMPLEMENTED** — extended con nuevos campos |
| `src/db/plans.ts` | createPlan, updatePlanStatus, deletePlan | **IMPLEMENTED** |
| `src/db/tasks.ts` | createTasksBatch, truncation 16KB | **IMPLEMENTED** — warning ≤5 tasks |
| `src/db/plan-create.ts` | planCreateExecutor, ensureSession | **IMPLEMENTED** |
| `src/db/plan-archive.ts` | serializePlanToMarkdown, archivePlan | **IMPLEMENTED** |
| `src/db/migrations.ts` | addColumnIfMissing, runMigrations | **IMPLEMENTED** |
| `src/plugin.ts` | 85-149 (escalateToForeman), 160-190 (reconcile), 756-766 (plan_delete), 941-963 (task_escalate), 1004-1014 (session_end) | **IMPLEMENTED** |
| `src/db/plans.test.ts` | 160-234 (deletePlan tests) | **IMPLEMENTED** |
| `src/db/plan-files.test.ts` | completo | **IMPLEMENTED** |
| `src/db/migrations-v8.test.ts` | completo | **IMPLEMENTED** |
| `src/plugin.test.ts` | 26-152 (escalateToForeman M2), 146-287 (reconcile M3) | **IMPLEMENTED** |
| `docs/bugs/plan-create-orphan-fk.md` | 60-70, 88-103 | Bug conocido, no resuelto |

### 11.2 Specs relacionados

| Recurso | Relación |
|---------|----------|
| `docs/features/feature-flexible-builder-v1.md` | Spec original v1 (archivada). Define `builder` con 3 estados. |
| `docs/features/feature-flexible-builder-v2.md` | Spec v2 (archivada). Define `craftsman` + foreman 4 pasos + migraciones v6/v7/v8. |
| `agents/foreman.md` | Prompt actual del foreman (4 pasos planner puro). |
| `agents/craftsman.md` | Prompt actual del craftsman (4 estados + routing + trivium). |
| `docs/agents.md` | Documentación de agents con sección craftsman. |
| `docs/workflows.md` | Árbol de decisión actualizado. |
| `src/db/schema.ts` | Schema DB con migraciones v1-v9. |

### 11.3 Árbol de decisión extendido (v3)

```
User envía prompt
  │
  ├─ ¿Tarea ≤2 archivos, ≤50 líneas, bien definida, sin dependencias externas?
  │   → `craftsman` en TUI → Estado 1 (trivial, sin plan_db)
  │   └─ Self-edit? ≤10 líneas, 1 file, 0 exports → directo
  │   └─ >10 líneas o >1 file → delegar a sub-smith
  │
  ├─ ¿Tarea 3-5 archivos, multi-stack, necesita tracking?
  │   → `craftsman` en TUI → Estado 2 (ad-hoc con plan_db)
  │   └─ ¿>3 archivos o multi-stack o >100 líneas diff?
  │       → Parallel dispatch: split en sub-tasks (1/stack), dispatch all
  │       └─ 1/N fails → retry-1-then-isolate
  │       └─ ≥2/N fails → fail-fast
  │
  ├─ ¿Tarea >5 archivos, diseño de arquitectura, o ambigua?
  │   → `foreman` en TUI → 4 pasos: Aclaración → Exploración → Plan → Persistir
  │   → Luego `craftsman` en TUI → Estado 3 (lee plan formal)
  │   └─ Craftsman encuentra algo fuera de dominio?
  │       → `task_escalate` (programático) o reportar [FUERA DE MI DOMINIO]
  │
  ├─ ¿Auditoría de PR existente o tarea read-only?
  │   → `craftsman` o `scout` según necesite escribir
  │
  ├─ ¿Exploración read-only?
  │   → `scout` en TUI
  │
  └─ ¿Terminar sesión regularmente?
      → `session_end` → reconcile hook → planes ejecutando → abandoned
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

### plan_files multi-role PK (`src/db/schema.ts:481-486`)

**Estado:** ⏳ PENDING — PK `(plan_id, file_path)` impide que un archivo tenga roles múltiples (`'input'` + `'modified'`). Resolución programada para Fase 3 (L7) del plan `flexible-builder-v3-lows`.

---

*Fin del feature spec v3 — documenta el estado post-merge del refactor Primary Craftsman*

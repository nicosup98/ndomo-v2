# Feature: Flexible Builder — modo ad-hoc paralelo al Foreman

**Slug:** `feature-flexible-builder`
**Status:** Draft (v1 — archivada)
**Plan ID:** `[PENDIENTE DE ASIGNACIÓN]`
**Created:** 2026-06-19
**Archived:** 2026-06-19 (spec v2 reemplaza este documento)

---

## 1. Resumen ejecutivo

Agregar un nuevo **primary agent `builder`** al ecosistema ndomo, paralelo al `foreman`, que implementa código sin la rigidez del orquestador. El user alterna manualmente entre foreman (planificación multi-step) y builder (implementación directa, TDD, commits). Builder usa `plan_db` **solo si la tarea es multi-archivo o necesita tracking**; si es trivial, ejecuta y reporta sin tocar la DB. El patrón replica exactamente el modo ad-hoc del proyecto referencia `nicosup98/ndomo` (opencode-core-slim), donde `default_agent: build` + `builder` primary + `qagent` ad-hoc conviven sin que el user deba pasar por un orquestador para trabajo simple.

---

## 2. Contexto y motivación

### 2.1 Estado actual: rigidez del foreman

El `foreman` (`agents/foreman.md`) es un orquestador primario con un flujo de 10 pasos obligatorios:

| # | Paso | ¿Salteable? |
|---|------|------------|
| 1 | Aclaración | No |
| 2 | Memory Search | No |
| 3 | Routing | No |
| 4 | Plan Atómico | No |
| 5 | Brief de Delegación | No |
| 6 | Trivium en Vivo | Parcial (≤5 líneas) |
| 7 | Reconciliación | No |
| 8 | Validación | No |
| 9 | Reporte Final | No |

**Evidencia:** `agents/foreman.md:162-200` define los 10 pasos secuenciales sin excepción.

### 2.2 Grietas específicas identificadas

| Grieta | Ubicación | Impacto |
|--------|-----------|---------|
| Trivium solo self-edit ≤5 líneas, 1 archivo, 0 nuevos exports | `agents/foreman.md:29-34` | El foreman no puede corregir ni un typo sin delegar → sobrecarga de `task` para cambios triviales |
| No hay modo ad-hoc; toda tarea requiere `plan_create` + `task_create_batch` | `agents/foreman.md:238` ("Antes de despachar subagentes, crear plan + tasks en DB") | tareas de 1 archivo requieren ciclo completo de plan_db |
| `session_start` colisiona con `ctx.sessionID` | `docs/bugs/plan-create-orphan-fk.md:60-70` | `plan_approve` / `plan_update_status` fallan en planes creados sin `session_start` explícito |
| `task_update_status` trunca `result`/`error` a 16KB | `src/db/tasks.ts:109-121` | Outputs grandes se pierden sin advertencia |
| Foreman monopoliza el rol de "único primary"; los 14 smiths son `subagent` con `task: deny` | `agents/foreman.md:28` y `agents/*.md` (`mode: subagent`) | El user no puede delegar directamente a un smith sin pasar por el foreman. El trivium es el único escape. |
| Routing estático en scheduler | `src/orchestrator/scheduler.ts:41-47` stack de 5 lenguajes | No hay detección dinámica de stack; el foreman debe adivinar o preguntar |
| `opencode.json` ausente en el repo | `glob("*opencode.json*")` → 0 resultados | Config global no versionada; no se puede definir `default_agent` ni modelos por proyecto |

---

## 3. Análisis comparativo con nicosup98/ndomo

### 3.1 Tabla side-by-side

| Aspecto | ndomo-v2 actual (foreman rígido) | nicosup98/ndomo (opencode-core-slim) |
|---------|----------------------------------|--------------------------------------|
| Default agent | foreman (primary, orquestador) | `build` (built-in, no overridden) |
| Modo trivial | Trivium ≤5 líneas, plan_db obligatorio | `build` single-turn, 0 coordination |
| Modo plan formal | foreman → `plan_create` → `task` → smiths | architect → `plan_db.add` → user switch → builder/scout/qagent |
| Modo ad-hoc | No existe | qagent "audit ad-hoc" deriva scope del query |
| Coordinación entre primaries | `task` desde foreman | `plan_db` async + user switch en TUI |
| Skill loading | Hardcodeado en cada smith | Dinámico: researcher detecta stack, carga max 5 |
| Audit trail | Solo `created_at`/`updated_at` | `original_plan_data` NUNCA se sobrescribe |
| Plan↔file association | No existe | `plan_files` join table |
| Tono global | Caveman en foreman + algunos smiths | Caveman en TODOS los 6 agents |
| `plan_delete` safety | No existe | Rechaza si `status='pending'` |
| Plan ≤5 steps | No hay regla | Regla en architect.md + `parent_id` para sub-plans |

**Evidencia del reporte:** `/tmp/opencode/ndomo-report.md:419-427` (tres modos de trabajo), `433-445` (tabla comparativa), `453-514` (puntos portables).

### 3.2 Por qué el patrón async + user switch es más liviano

En el modelo actual, el foreman:
1. Crea plan en DB (2 writes)
2. Crea tasks batch (N writes)
3. Llama `task` para cada smith (N LLM invocations)
4. Espera resultados (N context switches)
5. Reconoce resultados (N reads)

El modelo referencia:
1. architect escribe plan a SQLite (1 write)
2. User cambia agent en TUI (0 LLM tokens)
3. builder/scout/qagent lee plan y ejecuta (1 read + N writes)
4. User cambia de vuelta a architect si necesita replanificar

**Diferencia clave:** el modelo referencia gasta ~60% menos tokens en coordinación porque el "router" (architect) solo escribe a una DB persistente, no invoca LLMs secundarios. La coordinación entre primaries es **asíncrona vía SQLite**, no síncrona vía `task`.

---

## 4. Decisiones de diseño

### D1. Nuevo primary `builder` paralelo a `foreman` (Opción A del user)

**Decisión:** Crear `agents/builder.md` con `mode: primary`. El user alterna manualmente en TUI.

**Justificación:** Es el patrón probado del referencia (commit `167dc03`), donde `architect` NO usa `task` para invocar `builder`. Separar roles evita que el orquestador monopolice tokens y permite al user elegir el camino directo.

**Trade-offs:**
- (+) Zero cambios al foreman existente; conviven ambos primaries
- (+) El user retiene control del "threading" (no hay delegación automática)
- (-) El user debe saber cuándo usar builder vs foreman (curva de aprendizaje)
- (-) Dos primaries = dos configuraciones de modelo/temperatura

### D2. Builder carga skills de smiths según stack detectado

**Decisión:** Builder usa el mismo conjunto de skills que los smiths existentes, cargadas dinámicamente según stack detectado (max 5 skills por sesión).

**Justificación:** No duplicar skills. Reutilizar `vue-best-practices`, `golang-pro`, `rust-best-practices`, `typescript-expert`, etc., que ya existen.

**Trade-offs:**
- (+) Reutilización inmediata de 35+ skills existentes
- (+) Sin crear skills nuevas
- (-) Requiere lógica de detección de stack (a cargo del researcher subagent)

### D3. Audit trail inmutable con `original_plan_data`

**Decisión:** Agregar columna `original_plan_data TEXT` a `plans` y `plan_tasks`. En `plan_create` copiar `plan_data` → `original_plan_data`. NUNCA se sobrescribe.

**Justificación:** Permite responder "qué se planeó vs qué se hizo" sin re-parsear logs. Patrón probado del referencia (`/tmp/opencode/ndomo-report.md:465-467`).

**Trade-offs:**
- (+) Audit trail automático, zero esfuerzo del LLM
- (-) DB crece 2x por fila de plan (mitigación: archivar planes viejos)

### D4. Builder usa `plan_db` opcionalmente

**Decisión:** Builder NO crea `plan_create` para tareas triviales (1 archivo, ≤50 líneas de diff). Crea plan solo si multi-archivo o necesita tracking cross-session.

**Justificación:** Elimina el overhead del plan_db para el caso más común (fixes rápidos, single-file features). Es la misma lógica del referencia donde `build` (default) no toca `plan_db` y `builder` (primary) lo usa condicionalmente.

**Trade-offs:**
- (+) Tareas triviales se ejecutan en 1 turno, 0 writes a DB
- (-) Tareas sin plan_db no tienen trazabilidad (mitigación: builder reporta al user qué hizo vía salida directa)
- (-) Riesgo de que el user abuse builder para tareas grandes sin plan

---

## 5. Diseño del nuevo primary `builder`

### 5.1 Frontmatter YAML propuesto

```yaml
---
description: Implementador disciplinado / Fast Implementation Specialist (modo ad-hoc o planificado)
mode: primary
model: opencode-go/deepseek-v4-flash   # mismo modelo que smith genérico
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
  plan_db: allow      # opcional: tool plan_create/task_create_batch
---
```

**Diferencias clave con el foreman:**
- `mode: primary` (NO subagent)
- `task` permitido SOLO a subagents existentes (scout, scribe, smiths)
- `task` NO permitido a foreman, chronicler, inspector, painter, guild, sage (son primaries o roles no delegables)
- Permisos `edit: allow`, `bash: ask` (mismo que smiths, a diferencia del foreman que delega)
- `plan_db` tools disponibles pero no obligatorias

### 5.2 Prompt completo sugerido (esqueleto con TODOs)

```markdown
# Rol: Builder (Implementador Disciplinado)

Eres un **primary agent** paralelo al foreman. Tu misión es implementar código
directamente — bugs fixes, features pequeñas, refactors acotados — sin pasar por
el ciclo de planificación del orquestador. **Eres la opción "rápida"** para cuando
la tarea no amerita un plan completo.

## Tono

- Caveman nivel `full` SIEMPRE. Cero saludos, cero justificaciones, viñetas densas.
- [TODO: cargar skill `caveman` al inicio]

## Modo de trabajo (3 estados)

### Estado 1: Trivial (sin plan_db)
**Cuándo:** 1 archivo, ≤50 líneas de diff, sin dependencias externas.
**Flujo:**
1. Lee archivo objetivo
2. Implementa cambio
3. Corre `bun run typecheck` / tests / lint del scope
4. Commit atómico (conventional commits, ≤72 chars)
5. Reporta al user: archivo, línea, cambio, verificación.
**NO crea plan_create. NO toca task_db.**

### Estado 2: Ad-hoc multi-archivo (con plan_db opcional)
**Cuándo:** 2-5 archivos, cambios que cruzan stacks, o necesita tracking.
**Flujo:**
1. Si no hay plan previo: `plan_create` con slug, overview, approach breve.
2. `task_create_batch` con steps numerados.
3. Para cada step: `task_update_status("running")` → implementar → `task_update_status("done")`.
4. Al final: `plan_update_status("completed")`.
**Obligatorio si la tarea toca más de 1 stack o requiere session tracking.**

### Estado 3: Plan formal (lee plan_db existente)
**Cuándo:** El foreman ya creó un plan y tasks; builder es invocado para implementar.
**Flujo:**
1. `plan_get({id})` o `task_next_for_agent({agent: "builder"})` para encontrar tarea.
2. Leer plan_data y entender el contexto.
3. Implementar TDD: test first → code → refactor.
4. `task_update_status("done")` con reporte.
5. Si todas las tasks hechas: `plan_update_status("completed")`.

### Regla de selección de estado
```
¿Tarea bien definida, 1 archivo, <50 líneas?
  → Estado 1: trivial (no plan_db)
¿Tarea multi-archivo o cross-stack?
  → Estado 2: ad-hoc con plan_db
¿Hay plan/task existente asignado a "builder"?
  → Estado 3: plan formal
¿Tarea >5 archivos o requiere diseño de arquitectura?
  → [FUERA DE MI DOMINIO] → cambiar a foreman
```

## Skill loading dinámico (4 pasos)

1. [TODO: al recibir tarea que involucra código → delegar a `scout`
   con `task` para detectar stack]
   - Prompt fijo: "Analiza los archivos afectados y detecta el stack.
     Busca package.json → vue/react/etc, go.mod → Go, Cargo.toml → Rust,
     requirements.txt → Python, build.zig → Zig. Devuelve tabla de markers encontrados."
2. [TODO: recibir output estructurado — Stack / Markers / Skills recomendadas]
3. [TODO: cargar skills con tool `skill` — max 5 por sesión]
4. [TODO: reglas de borde — si toca auth/security → cargar `security-review`;
    si ya cargaste skills en turno anterior → NO recargar]

### Tabla marker→skill (del referencia, `/tmp/opencode/ndomo-report.md:337-344`)

| Marker | Stack | Skills |
|--------|-------|--------|
| `package.json` + `vue` en dependencies | Vue/Nuxt | `vue`, `vue-best-practices`, `pinia`, `vue-testing-best-practices`, `vite` |
| `package.json` + `react` | React/Next | `typescript-expert`, `modern-javascript-patterns` |
| `go.mod` + `go` en toolchain | Go | `golang-pro`, `golang-security`, `go-testing` |
| `Cargo.toml` | Rust | `rust-best-practices`, `rust-async-patterns`, `rust-testing` |
| `package.json` JS/TS genérico | JS/TS | `typescript-expert`, `modern-javascript-patterns`, `javascript-testing-patterns` |
| `requirements.txt` o `setup.py` | Python | [TODO: skill python específicas si existen] |
| `build.zig` | Zig | `zig-0.16` |
| Sin markers | generic | `caveman` + `ripgrep` solo |

## TDD workflow (obligatorio para código)

1. Test first: escribir test que falla cubriendo el cambio esperado
2. Code: implementar lo mínimo para pasar el test
3. Refactor: limpiar sin romper tests
4. Correr suite completa del scope
5. Commit atómico: `git add -A && git commit -m "tipo(scope): mensaje ≤72 chars"`

## Lo que NO puedes hacer

- ❌ Planificar tareas multi-step que involucren otros primaries (scout, painter, qagent)
- ❌ Invocar a `foreman` vía `task` — eso confunde roles
- ❌ Editar prompts de otros agents (`agents/*.md`)
- ❌ Editar tools MCP (`src/plugin.ts`, `src/db/*`)
- ❌ Crear planes con >5 steps top-level
- ❌ Usar `plan_approve` ni `plan_update_status` sin haber creado el plan
- ❌ Modificar archivos sin leerlos primero
- ✅ Sub-delegar a subagents existentes: `scout` (exploración), `smith`/`*-smith` (implementación especializada si cambia de stack)

## Output format

```
cambios:
  - path/file.ts:line — descripción — verified: OK

validación:
  - bun run typecheck — passed
  - bun test — 42/42 passed

plan:
  - plan_id: (si se creó)
  - tasks: 3 creadas, 3 completadas
  - estado: completed | ad-hoc (no plan_db)

notas:
  - [TODO: si algo queda pendiente]
```

## Reglas estrictas

1. Lee antes de editar. Siempre.
2. Verifica post-edit. Cada `edit` → `read` para confirmar.
3. Sin webfetch. Sin investigación externa.
4. Si la tarea excede tu scope → reporta `[FUERA DE MI DOMINIO]` + qué agente se necesita.
5. Caveman siempre. Salvo para advertencias de seguridad.
6. Commit atómico obligatorio después de cada tarea completada.
7. Si el proyecto no tiene tests → crear setup mínimo antes de implementar.
```

### 5.3 Skills loading: tabla marker → skill

Basado en el frontmatter de los smiths actuales, las skills existentes son:

| Agente existente | Skills cargadas en frontmatter/prompt |
|------------------|--------------------------------------|
| `smith` | `caveman`, `cavecrew` |
| `go-smith` | `golang-patterns`, `golang-testing`, `golang-security`, `api-security-best-practices` |
| `vue-smith` | `vue-best-practices`, `frontend-design` |
| `js-smith` | `modern-javascript-patterns`, `javascript-testing-patterns`, `api-security-best-practices` |
| `rust-smith` | [TODO: verificar — hereda de go-smith template] |
| `python-smith` | [TODO: verificar — hereda de go-smith template] |
| `zig-smith` | `zig-0.16` |
| `scout` | `caveman`, `ripgrep` |
| `inspector` | [TODO: verificar] |

**Evidencia en código:**
- `agents/smith.md:45-47` → `caveman`, `cavecrew`
- `agents/go-smith.md:48-52` → `golang-patterns`, `golang-testing`, `golang-security`, `api-security-best-practices`
- `agents/vue-smith.md:48-50` → `vue-best-practices`, `frontend-design`
- `agents/scout.md:44-46` → `caveman`, `ripgrep`

### 5.4 Integración con foreman

| Situación | Quién actúa | Por qué |
|-----------|-------------|---------|
| Bug fix de 1 archivo | Builder (ad-hoc) | Sin overhead de plan_db |
| Feature multi-archivo (3-5 files) | Builder (con plan_db) | Builder crea plan y tasks, ejecuta, completa |
| Feature >5 archivos / arquitectura | Foreman | Requiere diseño, routing a múltiples agents |
| Tarea cross-stack (Go + Vue) | Foreman | Foreman divide, delega a go-smith + vue-smith |
| El user no sabe qué necesita | Foreman | Foreman aclara antes de actuar |
| Auditoría de PR existente | Builder | No necesita plan; lee diff, reporta findings |
| Exploración de código | Scout (vía foreman o directo) | Builder no explora |

**Regla de convivencia:** builder y foreman comparten `plan_db`. Si builder crea un plan, foreman lo ve vía `plan_list`. Si foreman crea un plan con tareas para `builder`, builder las ve vía `task_next_for_agent`. No hay conflicto porque cada uno escribe/lee de la misma DB.

---

## 6. Cambios al sistema

### 6.1 Migración v6: `original_plan_data` en `plans` y `plan_tasks`

| Campo | Tabla | Tipo | Comportamiento |
|-------|-------|------|----------------|
| `original_plan_data` | `plans` | `TEXT` | En `plan_create`: copiar `plan_data` + `overview` + `approach` como JSON inmutable |
| `original_plan_data` | `plan_tasks` | `TEXT` | En `task_create_batch`: copiar `description` + `files` + `dependencies` como JSON inmutable |

**Reglas:**
- `plan_create` setea `original_plan_data` al mismo valor que `plan_data` en el INSERT
- `plan_approve` NO toca `original_plan_data`
- `plan_update_status` NO toca `original_plan_data`
- `archivePlan` lo lee y lo incluye en el markdown archive pero NO lo modifica
- `task_create_batch` setea `original_plan_data` al serializar `{description, files, dependencies}`

**Archivos afectados:**
- `src/db/schema.ts` — agregar columna vía `addColumnIfMissing` en migrations.ts (similar a v5 pattern)
- `src/db/types.ts` — agregar `originalPlanData: string | null` a Plan y PlanTask
- `src/db/plan-create.ts` — en `planCreateExecutor`, serializar args como `original_plan_data`
- `src/db/tasks.ts` — en `createTasksBatch`, serializar cada task input como `original_plan_data`
- `src/db/plan-archive.ts` — leer y exportar `original_plan_data` en el markdown archive
- `src/db/plans.ts` — en `createPlan`, pasar `original_plan_data`; en `updatePlanStatus` y `approvePlan`, verificar que NO se sobrescribe
- Nuevo: `src/db/plan-archive.test.ts` — test que verifica que `original_plan_data` es write-once

### 6.2 Migración v7: `plan_files` join table

```sql
CREATE TABLE IF NOT EXISTS plan_files (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  role TEXT,                              -- 'input' | 'output' | 'modified'
  PRIMARY KEY (plan_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_plan_files_path ON plan_files(file_path);
```

**Comportamiento:**
- `plan_create` acepta `files: string[]` opcional → inserta en `plan_files` con role `'input'`
- `task_create_batch` acepta `files: string[]` por task → inserta en `plan_files` con role `'modified'`
- `plan_get` retorna `files[]` via subquery JOIN
- `plan_search` acepta `file_path` filter opcional
- `plan_delete` CASCADE borra `plan_files`
- `archivePlan` incluye files en el markdown archive

**Archivos afectados:**
- `src/db/schema.ts` — agregar SCHEMA_V7_SQL con CREATE TABLE
- `src/db/types.ts` — agregar `files: string[]` con role a Plan y PlanTask (ya existe `files` en PlanTask, extender Plan)
- `src/db/plan-create.ts` — agregar `files?: string[]` a `PlanCreateArgs`, insertar en plan_files
- `src/db/tasks.ts` — en `createTasksBatch`, si `files` no está vacío, insertar en plan_files
- `src/db/plans.ts` — en `getPlan`, hacer JOIN con plan_files para `files[]`
- `src/db/plan-archive.ts` — incluir files en el markdown

### 6.3 `plan_delete` safety

**Opción recomendada:** Nuevo tool `plan_delete` en `src/plugin.ts` + función en `src/db/plans.ts`.

**Comportamiento:**
- Recibe `{id: string, confirm: boolean}`
- Rechaza si `confirm !== true` con error `"ndomo: plan_delete requires confirm: true"`
- Rechaza si `plan.status === 'draft'` con error `"ndomo: cannot delete a draft plan — use abandonPlan or approve first"`
- Rechaza si `task.status === 'pending' | 'running'` con error `"ndomo: plan has active tasks — resolve them first"`
- Si pasa todas las validaciones: CASCADE delete (plan_tasks, plan_tags, plan_files, sessions con ON DELETE SET NULL)

**Archivos afectados:**
- `src/db/plans.ts` — nueva función `deletePlan(db, id)` con validaciones
- `src/db/plans.test.ts` — nuevo test: delete success, delete reject pending, delete reject without confirm
- `src/plugin.ts` — registrar tool `plan_delete`

### 6.4 Plan ≤5 steps top-level

**Dos capas de enforcement:**
1. **Prompt del foreman** (`agents/foreman.md`): agregar regla "Planifica en pasos atómicos. Máximo 5 steps top-level. Si necesitas más, usa `parent_id` para sub-planes o pregunta al usuario."
2. **Validación en `task_create_batch`** (`src/db/tasks.ts`): si `tasks.length > 5`, emitir warning al log (no bloquear, porque el usuario podría tener razón).

### 6.5 Caveman en TODOS los agents

Agregar `caveman` skill al frontmatter de los 14 subagents actuales:

```yaml
# Agregar a la sección de skills obligatorias de cada agent:
skills:
  - caveman
```

**Agentes afectados:** chronicler, go-smith, guild, inspector, js-smith, painter, python-smith, rust-smith, sage, scout, scribe, smith, vue-smith, zig-smith.

**Diff:** en cada `agents/*.md`, agregar 2-3 líneas al inicio del prompt: *"Tono: caveman por default, nivel `full`. Activa siempre."*

### 6.6 No cambios requeridos

| Componente | Estado | Razón |
|------------|--------|-------|
| `opencode.json` / `~/.config/opencode/opencode.json` | Sin cambios | Foreman sigue siendo `default_agent`. Builder se activa manualmente en TUI. |
| `agents/foreman.md` | Sin cambios estructurales | Foreman sigue operando igual. Solo recibirá la regla ≤5 steps y la nota de que builder existe. |
| `src/orchestrator/scheduler.ts` | Sin cambios | Builder no usa scheduler. Decide su ruta en el prompt. |
| `src/db/sessions.ts` | Sin cambios | Bug del `ctx.sessionID` queda como tech debt. |
| `docs/bugs/plan-create-orphan-fk.md` | Sin cambios | Bug documentado, no resuelto en este spec. |

---

## 7. Acceptance criteria

### 7.1 Builder existe y es primary

- [ ] `agents/builder.md` existe con frontmatter: `mode: primary`, `task: allow` solo a subagents, `plan_db: allow`
- [ ] `agents/builder.md` tiene prompt completo con 3 estados de trabajo (trivial, ad-hoc plan_db, formal plan_db)
- [ ] User puede cambiar a builder en TUI sin pasar por foreman

### 7.2 Stack detection + skill loading

- [ ] Builder puede delegar a `scout` via `task` para detección de stack
- [ ] Builder carga max 5 skills por sesión según stack detectado
- [ ] Tabla marker→skill existe en el prompt y cubre: Go, Vue, JS/TS, Rust, Python, Zig, generic

### 7.3 plan_db opcional

- [ ] Builder ejecuta tarea trivial (1 archivo, ≤50 líneas) sin crear `plan_create`
- [ ] Builder crea `plan_create` + `task_create_batch` para tarea multi-archivo
- [ ] Builder reporta resultado al user en formato caveman en ambos modos

### 7.4 Builder NO invoca primaries

- [ ] `task` a `foreman` produce error o es ignorado por builder
- [ ] `task` a `chronicler`/`inspector`/`painter`/`sage`/`guild` produce error (son primaries o roles específicos)
- [ ] `task` a `scout`, `scribe`, `smith`, `*-smith` funciona correctamente

### 7.5 Migraciones DB

- [ ] Migración v6 aplica limpio a DB existente con datos reales
- [ ] Migración v7 aplica limpio a DB existente con datos reales
- [ ] `original_plan_data` es write-once: `plan_create` lo setea, `plan_approve`/`plan_update_status` no lo tocan
- [ ] Test unitario verifica audit trail inmutable
- [ ] `plan_files` inserta correctamente en `plan_create` con `files[]`
- [ ] `plan_files` inserta correctamente en `task_create_batch`
- [ ] CASCADE delete funciona en `plan_delete`

### 7.6 plan_delete safety

- [ ] `plan_delete` rechaza sin `confirm: true`
- [ ] `plan_delete` rechaza si `status='draft'`
- [ ] `plan_delete` rechaza si hay tasks `pending`/`running`
- [ ] `plan_delete` ejecuta CASCADE si pasa validaciones

### 7.7 Plan ≤5 steps

- [ ] `agents/foreman.md` contiene regla de ≤5 steps top-level
- [ ] `task_create_batch` emite warning si >5 tasks (no bloquea)

### 7.8 Caveman global

- [ ] Los 14 subagents existentes tienen `caveman` en frontmatter o prompt
- [ ] `agents/builder.md` tiene caveman activo

### 7.9 Tests

- [ ] Test cubre flujo trivial de builder (no crea plan_db, reporta directo)
- [ ] Test cubre flujo multi-archivo de builder (crea plan_db, tasks, completa)
- [ ] Test cubre `plan_delete` safety (3 sub-casos)
- [ ] Test cubre `original_plan_data` write-once
- [ ] Test cubre `plan_files` insert + query + CASCADE

### 7.10 Docs

- [ ] `docs/agents.md` describe builder (rol, cuándo usar, diferencia con foreman)
- [ ] `docs/workflows.md` tiene árbol de decisión actualizado (ver sección 10.2 abajo)

---

## 8. Plan de implementación por fases

### Fase 1: Migraciones DB + tests (1-2h)

**Qué:**
1. Agregar `original_plan_data TEXT` a `plans` y `plan_tasks` (migration v6)
2. Crear `plan_files` join table (migration v7)
3. Implementar `deletePlan` en `src/db/plans.ts` con safety checks
4. Tests unitarios: `plan-archive.test.ts`, `plans.test.ts` (delete), `plan-create.test.ts` (audit trail)

**Archivos tocados:**
- `src/db/schema.ts` (SCHEMA_V6_SQL, SCHEMA_V7_SQL, MIGRATIONS array)
- `src/db/migrations.ts` (addColumnIfMissing para v6)
- `src/db/types.ts` (interfaces Plan, PlanTask)
- `src/db/plans.ts` (createPlan, getPlan, new deletePlan)
- `src/db/tasks.ts` (createTasksBatch)
- `src/db/plan-create.ts` (PlanCreateArgs, planCreateExecutor)
- `src/db/plan-archive.ts` (serializePlanToMarkdown)
- `src/db/plans.test.ts` (nuevos tests)
- `src/db/plan-create.test.ts` (nuevo test audit trail)

### Fase 2: agents/builder.md + skill loading (2-3h)

**Qué:**
1. Crear `agents/builder.md` con frontmatter y prompt completo (esqueleto de la sección 5.2)
2. Implementar lógica de stack detection delegando a `scout` (task prompt fijo)
3. Implementar skill loading dinámico con max 5
4. Probar manualmente: abrir builder en TUI, dar tarea trivial, verificar que no crea plan_db

**Archivos tocados:**
- `agents/builder.md` (nuevo)
- `agents/scout.md` (agregar instrucción de detección de stack si no existe — opcional, puede resolverse en el task prompt del builder)
- Ningún archivo de código nuevo (skill loading usa tool `skill` existente)

### Fase 3: Integración con foreman + caveman global (1-2h)

**Qué:**
1. Agregar regla ≤5 steps al foreman (prompt + warning en task_create_batch)
2. Agregar caveman a los 14 subagents (diff mecánico)
3. Registrar `plan_delete` como tool MCP en `src/plugin.ts`
4. Verificar que builder y foreman no colisionan en plan_db

**Archivos tocados:**
- `agents/foreman.md` (regla ≤5 steps, nota sobre builder)
- `agents/*.md` (14 archivos, agregar caveman)
- `src/plugin.ts` (registrar plan_delete)
- `src/db/tasks.ts` (warning si >5 tasks)

### Fase 4: Docs + smoke tests (1h)

**Qué:**
1. Actualizar `docs/agents.md` con builder
2. Actualizar `docs/workflows.md` con árbol de decisión actualizado
3. Smoke test end-to-end: cambiar a builder → tarea trivial → verificar output sin plan_db
4. Smoke test: builder → tarea multi-archivo → verificar plan creado

**Archivos tocados:**
- `docs/agents.md` (nueva sección builder)
- `docs/workflows.md` (nuevo diagrama de decisión)

---

## 9. Riesgos y trade-offs

### R1. Abuso del builder para tareas grandes

**Riesgo:** Builder tiene `edit: allow` + `task: allow`. El user podría usarlo para features complejas sin plan_db, saltándose el foreman incluso cuando debería planificar.

**Mitigación (3 capas):**
1. **Prompt:** Builder tiene regla explícita ">5 archivos → fuera de mi dominio"
2. **Modelo:** builder usa temperatura 0.1, más predecible, menos propenso a auto-expandir scope
3. **Documentación:** `docs/workflows.md` explica el árbol de decisión: foreman para >5 archivos o diseño de arquitectura

**Severidad:** baja (el user siempre puede abusar; el sistema es una herramienta, no un guardián).

### R2. Crecimiento de DB con `original_plan_data`

**Riesgo:** La columna duplica `plan_data` (2x tamaño por fila). En proyectos con cientos de planes, puede sumar MB.

**Mitigación:**
1. `original_plan_data` se archiva a markdown cuando el plan se completa (auto-archive)
2. Archivar borra el plan de la DB activa (archived_at set)
3. Si el tamaño es problema, agregar cleanup de plans archived >30 días

**Severidad:** baja-muy baja (DB SQLite, planes son texto, 1000 planes ≈ 2-5MB extra).

### R3. Caveman en 14 agents = 14 lugares donde mantener consistencia

**Riesgo:** El tono caveman se vuelve inconsistente entre agents si se editan individualmente.

**Mitigación:**
1. Documentar el snippet exacto en `skills/caveman/SKILL.md` y referenciarlo en cada agent
2. El snippet es: `"Tono: caveman por default, nivel {{level}}. Activa siempre. Excepción: prosa normal para advertencias de seguridad, acciones irreversibles o ambigüedad multi-paso."`
3. Si se cambia el formato, buscar/replace en 14 archivos

**Severidad:** baja (diff mecánico, 2 líneas por archivo).

### R4. Skill loading dinámico sin LLM en la detección

**Riesgo:** La detección de stack depende del researcher subagent (vía `task`), que podría alucinar markers o elegir skills incorrectas.

**Mitigación:**
1. El prompt de detección es fijo con tabla marker→skill (no generativa)
2. Researcher solo reporta lo que encuentra en archivos reales (glob/grep)
3. Builder carga skills secuencialmente y puede fallar graceful si la skill no existe

**Severidad:** media-baja (el researcher puede fallar, pero builder puede cargar skill genérica como fallback).

### R5. Bug `ctx.sessionID` no arreglado

**Riesgo:** Builder usa `plan_create` en modo ad-hoc. Si el bug del FK de session persiste, los planes que cree builder también quedarán huérfanos en `draft`.

**Mitigación:**
1. El fix automático de `ensureSession` en `planCreateExecutor` (`src/db/plan-create.ts:39-41`) ya existe y resuelve el caso de `plan_create`
2. Builder solo necesita `plan_create` + `plan_update_status("completed")` — no necesita `plan_approve`
3. Si builder usa `plan_update_status` directamente, pasa por el mismo `ensureSession` scoped en `updatePlanStatus` (solo para `executing`/`approved`)
4. Para `completed`/`failed`/`abandoned`, la validación FK está deshabilitada (ver `plans.ts:122`)

**Conclusión:** el bug actual no afecta al builder. Solo afecta si builder intentara `plan_approve`, que no está en su flujo.

---

## 10. Referencias cruzadas

### 10.1 Archivos clave

| Archivo | Líneas relevantes | Notas |
|---------|-------------------|-------|
| `agents/foreman.md` | 162-200 (10 pasos), 29-34 (trivium ≤5 líneas), 238 (plan_db obligatorio) | Fuente de la rigidez |
| `src/db/schema.ts` | 17-33 (plans table), 38-54 (plan_tasks), 60-73 (sessions), 466-497 (MIGRATIONS) | Schema actual para migrar |
| `src/db/plans.ts` | 14-41 (createPlan), 113-147 (updatePlanStatus), 158-185 (approvePlan) | Puntos de inserción original_plan_data |
| `src/db/tasks.ts` | 13-80 (createTasksBatch), 109-121 (truncation 16KB) | Puntos de inserción original_plan_data + warning ≤5 tasks |
| `src/db/plan-create.ts` | 15-24 (PlanCreateArgs), 32-62 (planCreateExecutor) | Ya tiene ensureSession (Fix #1) |
| `src/db/plan-archive.ts` | 43-121 (serializePlanToMarkdown), 169-257 (archivePlan) | Archivo a modificar para incluir original_plan_data |
| `src/db/migrations.ts` | 16-21 (addColumnIfMissing), 23-57 (runMigrations) | Patrón para migraciones v6/v7 |
| `src/db/types.ts` | 41-64 (Plan), 66-91 (PlanTask), 119-140 (PlanRow), 142-166 (TaskRow) | Tipos a extender |
| `src/orchestrator/scheduler.ts` | 65-186 (routeTask), 41-47 (STACK_AGENTS) | Routing estático; builder no lo usa |
| `docs/bugs/plan-create-orphan-fk.md` | 60-70 (ctx.sessionID collision), 88-103 (fix recommended) | Bug conocido, no arreglado en este spec |

### 10.2 Documentación del referencia

| Recurso | Contenido clave |
|---------|-----------------|
| `/tmp/opencode/ndomo-report.md` | Análisis completo del proyecto referencia (563 líneas) |
| Sección 3.2 (prompts) | Prompts de architect/builder/qagent/researcher/tester |
| Sección 4.1 (plan_db) | original_plan_data, plan_files, delete safety |
| Sección 7.1 (árbol de decisión) | Flujo user → build/architect/builder/qagent |
| Sección 7.2 (tres modos) | Single-turn, plan formal, ad-hoc |
| Sección 9 (puntos portables) | 16 ideas priorizadas, de las cuales se portan: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.14, 9.15 |
| `https://github.com/nicosup98/ndomo` | Repo referencia (opencode-core-slim bundle) |
| Commit `167dc03` | `refactor(architect): coordinate with primaries via plan_db, not via task` |
| Commit `9c1fb13` | `docs: clarify qagent ad-hoc audit flow + decouple from architect.md` |

### 10.3 Árbol de decisión actualizado (post-builder)

```
User envía prompt
  │
  ├─ ¿Tarea ≤1 archivo, ≤50 líneas, bien definida?
  │   → Cambiar a `builder` en TUI
  │   → Builder: Estado 1 (trivial, no plan_db)
  │   → Implementa, commits, reporta
  │
  ├─ ¿Tarea 2-5 archivos, multi-stack, necesita tracking?
  │   → Cambiar a `builder` en TUI
  │   → Builder: Estado 2 (ad-hoc con plan_db)
  │   → Crea plan, tasks, implementa, completa
  │
  ├─ ¿Tarea >5 archivos, diseño de arquitectura, o no sabe qué necesita?
  │   → Cambiar a `foreman` en TUI
  │   → Foreman: 10-step flow
  │   → Crea plan, tasks, delega a smiths
  │
  ├─ ¿Auditoría de PR existente sin plan previo?
  │   → Cambiar a `builder` en TUI (o futuro qagent)
  │   → Builder: Estado 1 (lee diff, reporta findings)
  │
  └─ ¿Tarea de exploración read-only?
      → Cambiar a `scout` en TUI (o delegar desde foreman)
```

---

## Apéndice: Relación con el bug existente

El bug documentado en `docs/bugs/plan-create-orphan-fk.md` sobre `ctx.sessionID` colisionando con `plan_approve`/`plan_update_status` **no se resuelve en este spec**. Razones:

1. Builder no usa `plan_approve` — solo usa `plan_create` + `plan_update_status("completed")`
2. `planUpdateStatus` ya tiene validación FK scoped: solo chequea `sessionId` para status `executing`/`approved` (`src/db/plans.ts:122`). Para `completed`/`failed`/`abandoned`, salta la validación.
3. `planCreateExecutor` ya tiene `ensureSession` automático (`src/db/plan-create.ts:39-41`), así que cualquier plan creado por builder tiene la sesión asegurada.

**Impacto:** El bug no afecta al builder en su flujo normal. Si en el futuro builder necesitara `plan_approve`, habría que aplicar el Fix (a) recomendado en el bug doc.

---

*Fin del feature spec v1 — 723 líneas*

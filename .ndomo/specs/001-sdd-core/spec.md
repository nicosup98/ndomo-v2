---
id: SPEC-001
slug: sdd-core
title: Núcleo SDD (spec como fuente de verdad) + TDD red-proof para el desarrollo interno de ndomo
status: approved
version: 1.4
owner: foreman
created: 2026-10-04
updated: 2026-10-04
related_plans:
  - 7b337b7a-121a-457f-8f86-ceecb7401fce
related_designs:
  - .ndomo/designs/2026-10-04-sdd-core-design.md
related_tools:
  - spec_create
  - spec_get
  - spec_lint
supersedes: null
---

# SPEC-001 Núcleo SDD + TDD red-proof

## 1. Purpose

ndomo desarrolla software con agentes que ya operan sobre `plans` y `plan_tasks`, pero
`plans.overview/approach` es texto libre sin contrato verificable: nadie sabe si el código
implementa lo pedido, ni si lo pedido estaba claro. Esta spec introduce Spec-Driven
Development como disciplina interna: **la spec se escribe antes del código y es la fuente
única de verdad**, y el código se deriva de ella con TDD (cada requirement nace de un test
rojo etiquetado).

Valor: cerrar el gap spec↔código con una máquina que lo verifique, sin reescribir el
framework ni migrar la base de datos.

## 2. Scope

- Módulo `src/spec/` con template canónico, parser y linter determinista.
- Tools `spec_create`, `spec_get`, `spec_lint` (aditivos, sin tocar los 62 existentes).
- Gate **T0**: plan con `metadata.specId` no se aprueba con lint sucio.
- Gate **T1 ampliado**: task con `metadata.reqIds` exige red-proof TDD para `task_verify passed`.
- Convención de etiquetado de tests `REQ-xxx` y matriz de trazabilidad en la spec.
- Difusión: skill `spec-driven`, `docs/workflows.md`, agentes foreman/craftsman, README.

## 3. Non-goals

- **No** promover specs a tabla en DB (opción B): sin migración, sin FTS, sin FK.
- **No** reescribir `plans`/`plan_tasks`: se reutilizan vía `metadata` JSON existente.
- **No** slash-commands nuevos (`/speckit.*`): el flujo se expresa con tools + agentes.
- **No** constitution.md ni memoria permanente por proyecto (lo cubre `skills/ndomo` + agent files).
- **No** lint de calidad semántica del spec (qué significa "bien especificado"): eso es
  revisión humana/`grill-me`, no código.
- **No** obligatoriedad global: planes sin `metadata.specId` siguen exactamente igual.

## 4. Actors

| Actor | Necesita |
|---|---|
| Foreman | escribir la spec antes del plan, correr lint, mapear REQ→task |
| Craftsman | saber qué REQ/AC implementa su task, escribir el test rojo primero |
| Inspector | verificar que el código cumple REQ y que el red-proof es real |
| Usuario/reviewer | aprobar la spec como contrato; es el único que aprueba checklist de spec |
| Mantenedor | evolucionar la spec (changelog) sin que el código quede atrás |

## 5. Requirements

### REQ-001 — Scaffold canónico de spec
WHEN a caller requests the creation of a spec for a slug, THE system SHALL create
`.ndomo/specs/NNN-<slug>/spec.md` from the canonical template, with frontmatter keys
`id, slug, title, status, version, owner, created, updated, related_plans,
related_designs, supersedes` and the 13 mandatory sections in fixed order, using a
monotonically increasing `NNN` that never reuses an existing index.

- AC-001-1: **Given** `.ndomo/specs/001-foo/spec.md` exists, **When** creating slug `bar`,
  **Then** it creates `002-bar/spec.md` with `id: SPEC-002`.
- AC-001-2: **Given** the slug already exists on disk, **When** creating again,
  **Then** it fails without overwriting and reports the existing path.
- type: event-driven · priority: P1 · owner: craftsman · status: active

### REQ-002 — Lint estructural determinista
WHEN `spec_lint` runs on a spec, THE system SHALL return a JSON report with one finding per
violated rule, each finding carrying `rule` (`L0`–`L9`), `severity` (`error`|`warning`),
`line` and `message`, and the report SHALL be byte-identical across repeated runs.

- AC-002-1: **Given** a spec missing section `## 5. Requirements`, **When** linted,
  **Then** it returns error `L2` with the line of the first out-of-order heading.
- AC-002-2: **Given** a spec with 3 violations, **When** linted twice,
  **Then** both runs return identical JSON (sort stable by `line`, then `rule`).
- type: ubiq · priority: P1 · owner: craftsman · status: active

### REQ-003 — Trazabilidad REQ ↔ task ↔ test
WHEN a spec declares active requirements, THE system SHALL verify that every active REQ has
≥1 acceptance criterion, ≥1 plan task referencing it through `metadata.reqIds`, and a
traceability row; and SHALL flag any `reqIds` entry pointing to a REQ that is not defined
or is deprecated in that spec.

- AC-003-1: **Given** REQ-004 active with no task referencing it, **When** linted with
  `planId` context, **Then** it returns error `L6` listing REQ-004.
- AC-003-2: **Given** a task whose `reqIds` contains `REQ-999` (undefined),
  **When** linted, **Then** it returns error `L7` with the offending task id.
- type: ubiq · priority: P1 · owner: craftsman · status: active

### REQ-004 — Gate T0: spec limpia antes de aprobar plan
WHEN a plan with `metadata.specId` transitions to `approved`, THE system SHALL re-run
`spec_lint` and BLOCK the transition if any error-severity finding exists.

- AC-004-1: **Given** `metadata.specId` pointing to a spec with error `L2`,
  **When** `plan_approve` runs, **Then** it throws with actionable blockers and the plan
  remains `draft` with `approved_at` unset.
- AC-004-2: **Given** a clean spec, **When** `plan_approve` runs,
  **Then** approval succeeds and `approved_at` is set.
- type: event-driven · priority: P1 · owner: craftsman · status: active

### REQ-005 — Gate T1 ampliado: red-proof TDD obligatorio
WHEN a task has a non-empty `metadata.reqIds`, THE system SHALL refuse
`task_verify(verdict="passed")` unless the evidence carries a `redProof` (path or note of
a failing-test run executed **before** implementation) and ≥1 `testRef` tagged `REQ-xxx`.

- AC-005-1: **Given** a spec-bound task with non-empty `metadata.reqIds`,
  **When** `task_verify` is called with `verdict="passed"` and a `result` lacking
  `redProof` or any `REQ-xxx` `testRef`,
  **Then** the verdict is rejected with a message naming the missing fields.
- AC-005-2: **Given** the same task and a `result` carrying a non-blank `redProof`
  plus ≥1 `testRef` tagged `REQ-xxx`,
  **When** `task_verify` is called with `verdict="passed"`,
  **Then** the verdict is recorded as `passed` (existing inspector-only rule still applies).
- type: event-driven · priority: P1 · owner: craftsman · status: active

### REQ-006 — Opt-in y compatibilidad hacia atrás
IF a plan has no `metadata.specId`, THEN the system SHALL behave exactly as today (no lint,
no new blockers); and IF a task has no `metadata.reqIds`, the REQ-005 proof requirement
SHALL NOT apply.

- AC-006-1: **Given** the pre-existing test suite (plan/task/session lifecycle),
  **When** it runs, **Then** all tests pass unchanged (no new required field anywhere).
- type: ubiq · priority: P1 · owner: craftsman · status: active

### REQ-007 — Máquina de estados y regla de ambigüedad
WHILE a spec status is `draft` or `in-review`, the system SHALL tolerate
`[NEEDS CLARIFICATION: ...]` markers; WHEN status is `approved`, `implementing`, `verified`
or `deprecated`, any remaining marker SHALL be error `L4`.

- AC-007-1: **Given** status `approved` with 1 marker, **When** linted,
  **Then** it returns error `L4` naming the line.
- AC-007-2: **Given** the same file with status `in-review`, **When** linted,
  **Then** it returns no `L4`.
- type: state-driven · priority: P2 · owner: craftsman · status: active

### REQ-008 — Difusión y dogfooding
WHEN an agent starts work on a plan in ndomo's own repository, THE system SHALL expose the
SDD workflow through the skill `spec-driven` and the workflow docs, and this spec SHALL be
committed as the reference artifact.

- AC-008-1: **Given** the ndomo repository as the only consumer of SDD,
  **When** an agent consults the `spec-driven` skill,
  **Then** `skills/spec-driven/SKILL.md` documents the spec→red→green→refactor cycle
  and the `REQ-xxx` tagging rule for tests.
- AC-008-2: **Given** the same repository,
  **When** a reader opens the workflow and agent docs,
  **Then** `docs/workflows.md` contains the SDD section referencing gates T0/T1 and
  `.ndomo/specs/`, `agents/foreman.md` mandates the spec in its Phase 0, and
  `agents/craftsman.md` requires the red proof when `metadata.reqIds` is present.
- type: ubiq · priority: P2 · owner: craftsman · status: active

### REQ-009 — Superficie operativa mínima
WHEN ndomo is used from the shell, THE system SHALL expose `ndomo spec list|show|lint` as a
thin wrapper over the same module the tools use, and the repository SHALL keep `.ndomo/specs/`
versionable while ignoring `.ndomo/state.db` and its sidecars.

- AC-009-1: **Given** specs on disk, **When** `ndomo spec list` runs,
  **Then** it prints one line per spec (`id`, `status`, path); **When** `ndomo spec lint <id>`
  finds error findings, **Then** it exits non-zero and prints the same JSON as `spec_lint`.
- AC-009-2: **Given** `.ndomo/state.db` exists, **When** `git status --porcelain` runs,
  **Then** state.db and its `-wal`/`-shm` sidecars are ignored and `.ndomo/specs/` is not.
- type: ubiq · priority: P2 · owner: warden · status: active

## 6. Acceptance Criteria

Los AC viven anidados bajo cada REQ en la sección 5 (un AC = un test, tag `REQ-xxx-AC`).
No hay AC de sección propia: se documenta aquí para fijar la convención.

## 7. Interfaces / Contracts

### Tools (aditivos, total 62 → 65)

| Tool | Args | Returns |
|---|---|---|
| `spec_create` | `slug` (req), `title?`, `planId?`, `sessionId?`, `agent?`, `date?` | `{ id, slug, path, created: true, byteSize }` — error si el slug ya existe |
| `spec_get` | `id` \| `path` (uno req), `planId?` | `{ frontmatter, sections[], requirements[{id, type, priority, status, acs[]}], matrix[] }` |
| `spec_lint` | `id` \| `path` (uno req), `planId?` | `{ ok, findings[{rule, severity, line, message}], stats:{ reqs, acs, orphans } }` |

### Reglas de lint

| Rule | Severidad | Dispara |
|---|---|---|
| `L0` | error | archivo inexistente/ileíble |
| `L1` | error | frontmatter inválido (clave faltante, `id` ≠ `SPEC-\d{3}`, fecha no ISO) |
| `L2` | error | sección obligatoria faltante o fuera de orden (1–6, 11, 13) |
| `L3` | error | id de REQ mal formado, duplicado o con huecos de numeración |
| `L4` | error | `[NEEDS CLARIFICATION]` con status ≥ `approved` |
| `L5` | error | REQ active sin al menos un AC Given/When/Then |
| `L6` | error | REQ active sin task que lo referencie o sin fila en la matriz |
| `L7` | error | `metadata.reqIds` apunta a REQ inexistente o deprecado |
| `L8` | warning | fila de matriz con `tests` vacío |
| `L9` | warning | `updated` con >30 días y status `implementing`/`verified` (spec staleness) |

### Metadata (sin migración de DB)

- `plans.metadata.specId` → `"SPEC-001"` o path relativo (`.ndomo/specs/001-sdd-core/spec.md`).
- `plan_tasks.metadata.reqIds` → `["REQ-001", ...]`.
- `task_verify.result` → `{ redProof: string, testRefs: ["REQ-001-AC-1"] }` (opcional hoy,
  exigido cuando `reqIds` está presente).
- `plan_files.role = "spec"` → informativo para `plan_files_write`.

### Comandos CLI

`ndomo spec list | show <id> | lint <id> [--plan <planId>]` — wrapper delgado del módulo
(REQ-009), misma salida JSON que el tool.

## 8. Data Model

Sin tablas nuevas. Reutiliza:

- `plans.metadata` (JSON) ← `specId`
- `plan_tasks.metadata` (JSON) ← `reqIds`
- `plan_tasks.verification_result` (texto) ← JSON con `redProof`/`testRefs`
- Archivos `.ndomo/specs/NNN-<slug>/spec.md` — SSOT canónica en git (docs-as-code);
  `contracts/` opcional (openapi/asyncapi) referenciado desde la sección 7.

## 9. Edge Cases

| Situación | Comportamiento requerido |
|---|---|
| `specId` apunta a archivo borrado | T0 bloquea el approve con mensaje que nombra el path faltante (no L0 genérico) |
| Dos `spec_create` concurrentes por el mismo NNN | re-check de existencia justo antes de escribir; el segundo falla (nunca sobrescribe) |
| Spec con >1000 líneas | lint <200ms, sin escaneo de todo el repo |
| Task con `reqIds` de una spec **distinta** a la del plan | `L7` (no se valida contra otra spec) |
| Test etiquetado `REQ-xxx` sin REQ activo | warning (no error) en la revisión, no bloquea T0 |
| Plan abandonado con spec `implementing` | la spec queda en `implementing` y el lint L9 avisa en el siguiente plan |

## 10. NFRs

- **Determinismo**: sin IA (JEV), sin red, sin escrituras al DB durante lint.
- **Cero regresión**: `bun test` verde; ningún campo nuevo obligatorio.
- **Coste**: lint de una spec ≤1000 líneas en <200ms.
- **Idioma**: mensajes de lint en inglés (código), prosa de spec en español (equipo).
- **Adopción**: 3 tools nuevos; ningún flujo existente cambia salvo opt-in explícito.

## 11. Traceability

| REQ | AC | Tasks | Tests | state |
|---|---|---|---|---|
| REQ-001 | AC-001-1, AC-001-2 | o0 craftsman `src/spec` | `src/spec/spec.test.ts` | green |
| REQ-002 | AC-002-1, AC-002-2 | o0 craftsman, o1 js-smith | `src/spec/lint.test.ts`, `src/plugin.test.ts` | green |
| REQ-003 | AC-003-1, AC-003-2 | o0 craftsman, o1 js-smith | `src/spec/lint.test.ts`, `src/plugin.test.ts` | green |
| REQ-004 | AC-004-1, AC-004-2 | o2 craftsman | `src/db/plans.test.ts` | green |
| REQ-005 | AC-005-1, AC-005-2 | o2 craftsman | `src/db/tasks-verification.test.ts` | green |
| REQ-006 | AC-006-1 | o2 craftsman | `src/db/tasks.test.ts`, `src/plugin.test.ts` | green |
| REQ-007 | AC-007-1, AC-007-2 | o0 craftsman | `src/spec/lint.test.ts` | green |
| REQ-008 | AC-008-1, AC-008-2 | o5 craftsman | `docs/workflows.md` (check manual) | green |
| REQ-009 | AC-009-1 | o3 craftsman `src/cli` | `src/cli/__tests__/spec.test.ts` | green |
| REQ-009 | AC-009-2 | o4 warden `.gitignore` | `git check-ignore -v` | green |

Las filas T*n* son `order_index` (0-based) de las tasks del plan `7b337b7a-121a-457f-8f86-ceecb7401fce`
(slug `spec-driven-core`). `task_create_batch` auto-divide tasks multi-stack: la fila o1 quedo
partida en `js-smith` (src/plugin.ts, src/plugin.test.ts) y `smith` (docs/database.md), ambas
con los mismos `reqIds`. REQ-009 aparece en dos filas porque su trazabilidad cubre CLI (o3) e
higiene de repo (o4).

## 12. Open Questions

_(vacío — sin `[NEEDS CLARIFICATION]`)_

## 13. Changelog

- **2026-10-04 v1.4 (craftsman)** — correcciones post-verificación de la v1.3, prompted
  por la auditoría independiente que cerró el plan `spec-driven-core`:
  (a) el gate T1 leía solo el **primer** tag `REQ-xxx` de cada `testRef`, así que un tag
  no-vinculado al frente (`REQ-999`) enmascaraba uno válido posterior y rechazaba evidencia
  legítimos — ahora matchea todos los tags de cada ref; cubierto por 2 tests de regresión en
  `src/db/tasks-verification.test.ts`;
  (b) la firma de `recordTaskVerification` pasa de `result?: Record<string, unknown>` a
  `result?: unknown`, que es lo que el runtime ya aceptaba (una JSON *string* también);
  (c) el contrato de retorno de `spec_create` en §7 se alinea con la implementación real:
  `{ id, slug, path, created, byteSize }` en vez de `{ path, id, created }`. Sin cambios de
  comportamiento en el módulo `src/spec/`. Suite tras los cambios: 1337 pass / 2 fail.
- **2026-10-04 v1.3 (craftsman)** — las 10 filas de la matriz de §11 pasan de `red` a
  `green`: las 7 tasks del plan `spec-driven-core` quedaron implementadas y verificadas
  (`bun test` 1335 pass / 2 fail, los 2 pre-existentes de `src/mem/tags.test.ts` que dependen
  del entorno; `bun run typecheck` y `bun run lint` en exit 0). `status` se mantiene
  `approved` — promotes a `verified` es decisión del owner, no del implementador.
  Desviaciones aceptadas durante la ejecución, anotadas aquí para que no se pierdan:
  `src/spec` tolera `sessionId` en la entrada de `spec_create` pero lo descarta (el
  frontmatter canónico no tiene key de sesión); la plantilla trae un
  `[NEEDS CLARIFICATION]` de ejemplo en §12 que dispara `L4` si se promueve sin
  limpiarlo; el gate T0 corre `spec_lint` sin `ctx.tasks` a propósito (así `L6` solo
  bloquea por fila de matriz faltante, y la trazabilidad task↔REQ la cubre el gate T1);
  y `metadata.redProof` se valida como string no-blank, sin `existsSync`, porque
  distinguir "path" de "nota de prueba" es heurístico.
- **2026-10-04 v1.2 (craftsman, con visto bueno del owner)** — completados los ACs que
  violaban la propia regla `L5` de §7: `AC-005-1`/`AC-005-2` reciben la cláusula **When**
  que les faltaba y `AC-008-1`/`AC-008-2` reciben tríadas Given/When/Then completas. No cambia
  la semántica de REQ-005 ni de REQ-008, solo los vuelve verificables por `spec_lint`.
  Detectado por el smoke test de P1-T1 (`src/spec/`) contra esta spec real: reportaba
  `L5` error en REQ-005 (línea 113) y REQ-008 (línea 144). Alternativa descartada:
  relajar la lectura de `L5`, que habría debilitado la regla.
- **2026-10-04 v1.1 (foreman)** — agregada REQ-009 (CLI `ndomo spec` + higiene `.gitignore`)
  para que la task T4 de warden quede trazada en la matriz en vez de ser trabajo huérfano.
- **2026-10-04 v1 (foreman)** — spec inicial. Alcance recortado a MVP Opción C (spec como
  archivo + lint) tras interviews: SDD solo para desarrollo interno de ndomo, gate T0/T1
  opt-in por plan, spec convive con el design doc (spec = qué/contrato, design = por qué).
  Bootstrap: el T0 no pudo ejecutarse sobre este propio plan porque `spec_lint` no existía
  todavía; la exención queda registrada aquí como deuda explícita (ver consequences en el design doc).
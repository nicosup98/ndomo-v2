---
name: spec-driven
description: >
  Spec-Driven Development interno de ndomo: la spec (`.ndomo/specs/NNN-<slug>/spec.md`)
  es la fuente única de verdad y se escribe antes del código; cada REQ nace de un test
  rojo etiquetado `REQ-xxx`. Cobertura: ciclo spec → test rojo → código → verde → refactor,
  layout canónico de 13 secciones, convención de tags en tests, red-proof para
  `task_verify`, herramientas `spec_create`/`spec_get`/`spec_lint`, CLI `ndomo spec`,
  reglas de lint L0–L9 y criterios de opt-in.
  Use when creating or working on a spec, tracing requirements to tasks/tests, linting a
  spec, or on any plan whose tasks carry `metadata.reqIds`. Triggers: "spec", "SDD",
  "spec_create", "spec_lint", "REQ-001", "red-proof", "needs clarification".
---

# spec-driven — SDD para el desarrollo interno de ndomo

Spec-Driven Development: **la spec se escribe antes del código y es la fuente única de
verdad** (SSOT), commit-eada en git. El código se deriva de ella con TDD: cada requirement
nace de un test rojo etiquetado. Spec = qué/contrato; design doc = por qué (conviven:
[design_create](ndomo) sigue generando `.ndomo/designs/`).

Spec de referencia del ecosistema: `.ndomo/specs/001-sdd-core/spec.md` (SPEC-001, dogfood).

## 1. El ciclo

```
spec_create → spec_lint (ok:true) → plan (metadata.specId) → tasks (metadata.reqIds)
→ TEST ROJO (tag REQ-xxx) → código → verde → refactor → task_verify (redProof + testRefs)
→ plan completed → changelog de la spec
```

1. **`spec_create`** — genera `.ndomo/specs/NNN-<slug>/spec.md` desde el template canónico
   (frontmatter + 13 secciones). NNN monótono: nunca reusa índice existente. Falla sin
   sobrescribir si el slug ya existe.
2. **`spec_lint`** — itera hasta `{ ok: true }` (toda finding `error` resuelta) **antes** de crear el plan.
3. **`plan_create`** con `metadata.specId` — vincula el plan a la spec.
4. **`task_create_batch`** con `metadata.reqIds: ["REQ-xxx", ...]` en cada task — traza
   REQ → task.
5. **Test rojo primero** — ver §3 y §4. El test falla ANTES de implementar; ese output es la evidencia.
6. **Código → verde → refactor** — implementar lo justo para pasar el test, limpiar sin romper.
7. **`task_verify`** con `result: { redProof, testRefs }` — cierra el gate T1 (ver §4).
8. **Cierre** — plan `completed`; registrar el cambio en la sección `## 13. Changelog` de la spec.

## 2. Layout canónico (13 secciones en orden fijo)

Frontmatter: `id, slug, title, status, version, owner, created, updated, related_plans,
related_designs, supersedes`.

| # | Sección | ¿Obligatoria? |
|---|---|---|
| 1 | Purpose | ✅ |
| 2 | Scope | ✅ |
| 3 | Non-goals | ✅ |
| 4 | Actors | ✅ |
| 5 | Requirements (REQ + ACs anidados, `type`/`priority`/`owner`/`status`) | ✅ |
| 6 | Acceptance Criteria | ✅ |
| 7 | Interfaces / Contracts | opcional |
| 8 | Data Model | opcional |
| 9 | Edge Cases | opcional |
| 10 | NFRs | opcional |
| 11 | Traceability (matriz REQ ↔ AC ↔ Tasks ↔ Tests ↔ state) | ✅ |
| 12 | Open Questions | opcional |
| 13 | Changelog | ✅ |

Faltar o desordenar una sección obligatoria (1–6, 11, 13) = finding `error` `L2`.

## 3. Convención `REQ-xxx` en tests (por qué)

El nombre del test lleva el tag del requirement que verifica:

```ts
it("REQ-001-AC-1: crea 002-bar/spec.md con id SPEC-002", () => { ... })
test("REQ-002-AC-2: lint dos corridas byte-idénticas", () => { ... })
```

- **Es lo que hace la trazabilidad machine-checkable**: la matriz de la sección 11 declara
  `Tests` por REQ; el tag en el nombre permite cruzar test ↔ REQ sin escanear el repo (el
  lint valida la matriz declarada, no el código).
- Formato: `REQ-NNN` (3 dígitos), o `REQ-NNN-AC-M` cuando el test cubre un AC concreto.
- Un test etiquetado `REQ-xxx` sin REQ activo en la spec = warning en revisión, no bloquea.

## 4. Red proof (tasks con `metadata.reqIds`)

Cuando la task trae `metadata.reqIds` no vacío, `task_verify({verdict:"passed"})` exige
evidencia TDD (gate T1, SPEC-001 REQ-005):

1. **Escribir el test rojo primero** (tag `REQ-xxx`), antes de tocar código de implementación.
2. **Correrlo y capturar el output fallido** — esa captura es el red-proof; debe reflejar
   una ejecución anterior a la implementación (path del run o nota).
3. **`task_verify`**:

```ts
task_verify({
  taskId,
  verdict: "passed",
  result: {
    redProof: "bun test src/spec/lint.test.ts → 1 failed (L2 missing section)", // output previo a implementar
    testRefs: ["REQ-002-AC-1"], // ≥1 tag REQ-xxx
  },
})
```

- **`redProof`**: ruta o nota del run fallido PRE-implementación (string).
- **`testRefs`**: ≥1 tag `REQ-xxx` (array de strings).
- Sin ambos, el gate rechaza el `passed` con mensaje que nombra los campos faltantes.
- Sin `reqIds` → el flujo actual no cambia (opt-in, REQ-006); la regla inspector-only sigue aplicando.

## 5. `spec_lint` — tool y CLI

- **Tool**: `spec_lint({ id | path, planId? })` → `{ ok, findings[{rule, severity, line, message}], stats:{ reqs, acs, orphans } }`.
- **CLI**: `ndomo spec list | show <id> | lint <id> [--plan <planId>]` — wrapper delgado,
  misma salida JSON que el tool; `lint` exit != 0 si hay findings `error`.
- **Determinista**: sin IA (JEV), sin red, **cero escrituras al DB**. Byte-idéntico entre
  corridas repetidas (sort estable por `line`, luego `rule`). Lint de spec ≤1000 líneas: <200ms.
- `spec_lint` con `planId` añade contexto de trazabilidad (reglas L6/L7).

## 6. Reglas de lint L0–L9

| Rule | Severidad | Dispara |
|---|---|---|
| `L0` | error | archivo inexistente/ilegible |
| `L1` | error | frontmatter inválido (clave faltante, `id` ≠ `SPEC-\d{3}`, fecha no ISO) |
| `L2` | error | sección obligatoria faltante o fuera de orden (1–6, 11, 13) |
| `L3` | error | id de REQ mal formado, duplicado o con huecos de numeración |
| `L4` | error | `[NEEDS CLARIFICATION]` con status ≥ `approved` |
| `L5` | error | REQ active sin al menos un AC Given/When/Then |
| `L6` | error | REQ active sin task que lo referencie o sin fila en la matriz |
| `L7` | error | `metadata.reqIds` apunta a REQ inexistente o deprecado |
| `L8` | warning | fila de matriz con `tests` vacío |
| `L9` | warning | `updated` con >30 días y status `implementing`/`verified` (spec staleness) |

## 7. Cuándo es opt-in (y cuándo no)

SDD es **opt-in por plan** (`metadata.specId`). Aplicar cuando:

- Cambio que toca **>5 archivos**.
- **Diseño arquitectónico** o decisión de diseño de riesgo.
- Cambio **cross-team / de contrato** (API, schema, contract) donde la traza REQ→task→test importa.
- Requisitos **poco claros** que necesitan `[NEEDS CLARIFICATION: ...]` (el marker es legal con
  status `draft`/`in-review`; pasa a error `L4` al aprobar — resolver el marker o grill-me antes).

**Saltar SDD** para fixes triviales: ≤5 archivos, bien definidos, sin contrato — el flujo
ad-hoc queda exactamente igual (REQ-006).

## 8. Checklist operativo

```
[ ] spec_create({slug}) → path e id
[ ] spec_lint({id}) → ok:true (sin findings error)
[ ] plan_create(..., metadata.specId)
[ ] task_create_batch(..., metadata.reqIds por task)
[ ] por task con reqIds: test rojo tag REQ-xxx ANTES de implementar → capturar output
[ ] task_verify({verdict:"passed", result:{redProof, testRefs}})
[ ] plan completed → sección 13 Changelog actualizada
[ ] git add .ndomo/specs/ (SSOT commit-eado; .ndomo/state.db* ignorado)
```

Referencias: `.ndomo/specs/001-sdd-core/spec.md` (SPEC-001), `docs/workflows.md` (gates T0/T1),
`agents/foreman.md` (Phase 0), `agents/craftsman.md` (TDD + red-proof).
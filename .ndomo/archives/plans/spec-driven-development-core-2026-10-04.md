# Plan: SDD core: spec como fuente de verdad + spec_lint + gates T0/T1 + TDD red-proof

**Slug:** spec-driven-development-core  
**Status:** abandoned  
**Archived:** 2026-10-05T01:32:09.704Z  
**Priority:** 2  
**Complexity:** 4  
**Plan ID:** 5ef40833-687e-4243-aa9d-d6f16dbc0be7

## Overview

Adoptar Spec-Driven Development en el desarrollo interno de ndomo: la spec (archivo .ndomo/specs/NNN-slug/spec.md, REQ/AC/EARS + matriz de trazabilidad) se escribe antes del codigo y es la fuente unica de verdad. Incluye modulo src/spec (template + parser + linter determinista), 3 tools (spec_create/spec_get/spec_lint), gate T0 (plan con metadata.specId no se aprueba con lint dirty), extension de gate T1 (tasks con metadata.reqIds exigen red-proof TDD antes de task_verify passed), y difusion en agentes/docs/skills.

## Agent Trail

- **Created by agent:** foreman

## Original Plan Data (write-once)

```json
{"id":"5ef40833-687e-4243-aa9d-d6f16dbc0be7","slug":"spec-driven-development-core","title":"SDD core: spec como fuente de verdad + spec_lint + gates T0/T1 + TDD red-proof","overview":"Adoptar Spec-Driven Development en el desarrollo interno de ndomo: la spec (archivo .ndomo/specs/NNN-slug/spec.md, REQ/AC/EARS + matriz de trazabilidad) se escribe antes del codigo y es la fuente unica de verdad. Incluye modulo src/spec (template + parser + linter determinista), 3 tools (spec_create/spec_get/spec_lint), gate T0 (plan con metadata.specId no se aprueba con lint dirty), extension de gate T1 (tasks con metadata.reqIds exigen red-proof TDD antes de task_verify passed), y difusion en agentes/docs/skills.","approach":"Sin migracion de DB (metadata JSON existente). Precedente a replicar: design_create (artefacto-file DB-free). 5 tasks: (1) src/spec core + tests, (2) 3 tools en plugin.ts, (3) gates T0 en approvePlan + T1 red-proof en tasks.ts, (4) warden: higiene repo .gitignore + wrapper CLI ndomo spec, (5) difusion: skill spec-driven + docs/workflows.md + agents/foreman.md + craftsman.md + README. Opt-in por plan: metadata.specId ausente = comportamiento actual intacto. TDD obligatorio en el propio trabajo: cada REQ nace de un test rojo con tag REQ-xxx.","priority":2,"complexity":4,"category":null,"createdBy":"foreman","sourceSessionId":"ses_ef6646d08ffeH3tw0RklpRZi9h","sourceMessageId":"msg_109ac3c8d001HbskTZFd1L8ik5","files":[],"metadata":{"ownedBy":"foreman","methodology":"sdd+tdd","specRoot":".ndomo/specs","specSlug":"001-sdd-core","dogfood":true},"createdAt":1791163656972}
```

## Approach

Sin migracion de DB (metadata JSON existente). Precedente a replicar: design_create (artefacto-file DB-free). 5 tasks: (1) src/spec core + tests, (2) 3 tools en plugin.ts, (3) gates T0 en approvePlan + T1 red-proof en tasks.ts, (4) warden: higiene repo .gitignore + wrapper CLI ndomo spec, (5) difusion: skill spec-driven + docs/workflows.md + agents/foreman.md + craftsman.md + README. Opt-in por plan: metadata.specId ausente = comportamiento actual intacto. TDD obligatorio en el propio trabajo: cada REQ nace de un test rojo con tag REQ-xxx.

## Tasks (7 total, 0 done, 0 failed)

- [ ] **[T1] Modulo src/spec: template canonico + parser de frontmatter/secciones/REQ/AC/matriz + linter determinista con reglas L0-L9 (estructura, REQ ids, NEEDS CLARIFICATION vs status, trazabilidad REQ<->task<->test, staleness) + serializer. TDD: cada REQ arranca con test rojo etiquetado REQ-xxx (AC-001-1, AC-002-1/2, AC-003-1/2, AC-007-1/2). Cero DB, cero IA, cero red. Verificar con el propio linter contra la spec real .ndomo/specs/001-sdd-core/spec.md (debe salir ok:true).** — agent: craftsman, complexity: 4, status: pending
- [ ] **[T2] Tools spec_create, spec_get, spec_lint registrados en src/plugin.ts siguiendo el patron de design_create (toolDefs + registerTools, zod args en def.args). Actualizar el conteo de tools 62->65 en el test de registro de plugin.test.ts y en la tabla de tools de docs. Tests de tool en src/plugin.test.ts con tag REQ-002/REQ-003.** — agent: js-smith, complexity: 3, status: pending
- [ ] **[T2] Tools spec_create, spec_get, spec_lint registrados en src/plugin.ts siguiendo el patron de design_create (toolDefs + registerTools, zod args en def.args). Actualizar el conteo de tools 62->65 en el test de registro de plugin.test.ts y en la tabla de tools de docs. Tests de tool en src/plugin.test.ts con tag REQ-002/REQ-003.** — agent: smith, complexity: 3, status: pending
- [ ] **[T3] Gates: (a) T0 en approvePlan (src/db/plans.ts): si plan.metadata.specId existe, re-ejecutar spec_lint y bloquear la transicion a approved ante cualquier error; mensaje accionable con el path faltante cuando la spec no existe. (b) T1 ampliado en src/db/tasks.ts recordTaskVerification: si task.metadata.reqIds no vacio, task_verify passed exige result con redProof + >=1 testRef etiquetado REQ-xxx; regla inspector-only actual intacta. (c) Backward compat REQ-006: sin metadata.specId / sin reqIds el comportamiento no cambia. Tests en src/db/plans.test.ts, src/db/tasks-verification.test.ts, src/db/tasks.test.ts con tags AC-004-1/2, AC-005-1/2, AC-006-1. Correr bun test completo para证明 cero regresion.** — agent: craftsman, complexity: 4, status: pending
- [ ] **[T4] Higiene de repo + CLI: (a) .gitignore: cubrir .ndomo/state.db y sidecars (-wal/-shm) sin ignorar .ndomo/specs/, .ndomo/designs/, .ndomo/ledgers/ (verificar con git status --porcelain y git check-ignore). (b) comando CLI 'ndomo spec list|show|lint' como wrapper delgado de src/spec (src/cli/spec.ts + registro en src/cli/index.ts), misma salida JSON que el tool, exit code no-cero ante errores. Test en src/cli/__tests__/spec.test.ts con tags AC-009-1/AC-009-2.** — agent: smith, complexity: 2, status: pending
- [ ] **[T4] Higiene de repo + CLI: (a) .gitignore: cubrir .ndomo/state.db y sidecars (-wal/-shm) sin ignorar .ndomo/specs/, .ndomo/designs/, .ndomo/ledgers/ (verificar con git status --porcelain y git check-ignore). (b) comando CLI 'ndomo spec list|show|lint' como wrapper delgado de src/spec (src/cli/spec.ts + registro en src/cli/index.ts), misma salida JSON que el tool, exit code no-cero ante errores. Test en src/cli/__tests__/spec.test.ts con tags AC-009-1/AC-009-2.** — agent: js-smith, complexity: 2, status: pending
- [ ] **[T5] Difusion de la metodologia: (a) nuevo skill skills/spec-driven/SKILL.md con el ciclo spec -> test rojo -> codigo -> verde -> refactor, convencion REQ-xxx en tests, red-proof y como correr spec_lint; (b) agents/foreman.md: Phase 0 ahora incluye spec_create + spec_lint antes de plan_create (opt-in: >5 archivos o diseno arquitectonico); (c) agents/craftsman.md: requirement obligatorio de test rojo antes de implementar cuando la task trae metadata.reqIds, y adjuntar redProof en task_verify; (d) docs/workflows.md: nueva seccion SDD con gates T0 y T1 ampliado + diagrama d2 canonico en docs/diagrams/ (validar con d2 validate); (e) README.md y README.es.md: actualizar conteo de tools 62->65 y tabla de gates. Sin AGENTS.md en el repo: no crear.** — agent: craftsman, complexity: 2, status: pending

## Sessions (0)


## Metadata

```json
{
  "ownedBy": "foreman",
  "methodology": "sdd+tdd",
  "specRoot": ".ndomo/specs",
  "specSlug": "001-sdd-core",
  "dogfood": true
}
```

# Design: SDD core para ndomo interno: spec como artefacto-file + lint determinista + gates T0/T1

**Slug:** sdd-core  
**Date:** 2026-10-04  
**Status:** decided  
**Author:** foreman  
**Created:** 2026-10-05T01:30:15.871Z  
**Plan:** 5ef40833-687e-4243-aa9d-d6f16dbc0be7  
**Session:** ses_ef6646d08ffeH3tw0RklpRZi9h  

## Problem

ndomo desarrolla software con agentes usando plans/plan_tasks, pero plans.overview/approach es texto libre sin contrato verificable: no hay forma de saber si el codigo implementa lo pedido, ni si lo pedido estaba claro, ni de bloquear la deriva spec<->codigo. Falta una disciplina de tipo Spec-Driven Development (spec antes del codigo, SSOT) y el puente TDD (cada REQ nace de un test rojo).

## Goals

- Spec canonica en archivo (.ndomo/specs/NNN-slug/spec.md) con REQ/AC/EARS + matriz de trazabilidad
- Lint determinista (sin IA) como unidad de verificacion del spec
- Gate T0: plan con metadata.specId no se aprueba con lint sucio
- Gate T1 ampliado: task con metadata.reqIds exige red-proof TDD antes de task_verify passed
- Cero migracion de DB y cero regresion en los 62 tools existentes
- Difusion en skill spec-driven, docs/workflows.md, agentes foreman/craftsman, README
- Dogfood: esta primera spec es el artefacto de referencia y se valida con su propio linter

## Constraints

- Sin migracion de schema: reutilizar metadata JSON de plans y plan_tasks
- Determinismo: lint sin JEV, sin red, sin escrituras al DB
- Opt-in por plan (metadata.specId) para no romper el flujo ad-hoc de <=5 archivos
- Precedente tecnico a replicar: design_create (artefacto-file DB-free en .ndomo/designs/)
- Enforcement points existentes: src/db/plans.ts approvePlan y src/db/tasks.ts updateTaskStatus/recordTaskVerification
- .ndomo/ no esta gitignored (solo *.db*) -> los specs pueden ser SSOT en git; falta cubrir .ndomo/state.db

## Scope

- src/spec/ (template + parser + linter + serializer + unit tests)
- 3 tools aditivos en src/plugin.ts: spec_create, spec_get, spec_lint
- Gate T0 en approvePlan + gate T1 red-proof en tasks.ts
- CLI ndomo spec list|show|lint como wrapper delgado
- Skill spec-driven + actualizacion de docs/workflows.md, agents/foreman.md, agents/craftsman.md, README.md
- Higiene .gitignore: ignorar .ndomo/state.db* , mantener specs/designs/ledgers versionados

## Exclusions

- Promover specs a tabla en DB (opcion B): sin migracion, sin FTS, sin FK
- Slash-commands estilo /speckit.*
- constitution.md / memoria permanente por proyecto (lo cubre skills/ndomo + agent files)
- Lint de calidad semantica del spec (eso es grill-me + revision humana)
- Obligatoriedad global de spec para todo plan
- Escaneo de todo el repo para validar tags de test (solo la matriz de la spec)

## Options Considered

### A - extender design_create con bloque requirements

Agregar requirements/AC al ADR existente. Effort minimo (0.5-1 dia).

**Pros:**

- Esfuerzo minimo
- Sin archivo ni tool nuevo
- D2 y JSON ya resueltos

**Cons:**

- Mezcla decision tecnica (por que) con contrato funcional (que): exactamente la confusion que Fowler marca
- Sin status machine propia ni lint real de trazabilidad
- Spec queda atada a un documento fechado, no versionable como contrato

### B - spec como entidad en DB (tabla specs + 6-7 tools + FTS5 + FK + gate T0 propio)

SSOT consultable y lifecycle auditado. Effort 1-2 semanas + migraciones.

**Pros:**

- SSOT consultable por SQL
- Lifecycle y auditoria de cambios de REQ
- Precedente analyses+FTS5 existente

**Cons:**

- Segunda fuente de verdad (DB vs markdown) -> riesgo de drift bidireccional
- Rompe docs-as-code (git history deja de ser la auditoria)
- Overhead para specs triviales; superficie de 60 archivos de tests
- Deuda de migracion y rollback

### C - spec como artefacto-file + lint determinista (ELEGIDA)

.ndomo/specs/NNN-slug/spec.md canonico en git; 3 tools (spec_create/spec_get/spec_lint); traza via task.metadata.reqIds + tag REQ-xxx en tests; gates T0/T1 sin tocar schema. Effort 2-4 dias.

**Pros:**

- SSOT unica en git: sin drift DB<->file, historia = auditoria de spec evolution
- Mismo patron ya probado por design_create, sin unfamiliaridad para los agentes
- Lint determinista barato y testeable; reglas enumeradas L0-L9
- Opt-in preserva el flujo ad-hoc; rollback = borrar el directorio
- Frontmatter disenido con id/version/status para promover a tabla despues sin reshuffle

**Cons:**

- El lint solo corre si alguien lo ejecuta (mitigable: T0 lo fuerza en approvePlan)
- Sin busqueda por SQL/FTS de specs (mitigable: grep + path; deuda declarada)
- Specs triviales pagan el overhead del ritual SDD

### D - adopcion estricta de GitHub Spec Kit (8 artefactos por feature)

constitution/specify/clarify/plan/checklist/tasks/analyze/implement al pie de la letra.

**Pros:**

- Metodologia probada con tooling upstream
- Clarify loop de 5 preguntas por pasada

**Cons:**

- Review overload (Fowler: preferiria revisar codigo a todos esos markdowns)
- 8 archivos por feature es desproporcionado para cambios de <=5 archivos
- Gates de fase rigidos rozan waterfall con markdown


## Decision

Opcion C (spec como artefacto-file + lint determinista + gates T0/T1 opt-in), acotada al desarrollo interno de ndomo. Se descarta A como trampolin y como destino; B queda como evolucion futura si el MVP valida la adopcion (el frontmatter ya lleva id/version/status para promover sin reshuffle). De D se toman prestadas tres ideas concretas: clarificacion explicita ([NEEDS CLARIFICATION] + grill-me antes de aprobar), checklist de spec como 'unit tests del spec' que el implementador no auto-aprueba, y un analyze read-only de consistencia cruzada (aqui: spec_lint). La ordenacion spec -> test rojo -> codigo sigue Spec Kit constitution Article III.

## Trade-offs

- Menos automatizacion que una entidad en DB a cambio de cero drift y cero migracion
- Gate T0 depende de ejecucion de lint en approvePlan: si un agente invoca el executor de DB saltandose el punto de approve, la disciplina se pierde (mitigacion: enganchar el check en approvePlan y cubrirlo con tests)
- Lint de tests opcional: solo se valida la matriz declarada, no se escanea el repo (evita costo O(repo) y falsos positivos)
- 1 spec = 1 feature como maximo: acota bloating (spec theater) y mantiene el review manejable
- Red-proof verificable por evidencia adjunta, no por sandbox: se acepta que un agente pueda mentir sobre el rojo (mitigacion futura: harness que ejecute el test antes de la implementacion)

## Consequences

- El gate T0 no pudo aplicarse a este propio plan (bootstrap): spec_lint no existia al aprobar; excepcion registrada en el changelog de SPEC-001 y se cierra cuando T3 entregue el gate
- 3 tools nuevos (62 -> 65): hay que actualizar el conteo en README.md, skills/ndomo/SKILL.md y el test de registro de plugin.test.ts
- El trabajo futuro de ndomo con mas de ~5 archivos o diseno arquitectonico empieza por spec_create; el trabajo ad-hoc queda exento
- Los tests nuevos deben llevar tag REQ-xxx en el nombre para que la matriz sea verificable
- Deuda declarada: CLI ndomo spec, busqueda de specs, promocion a tabla (opcion B), ejecucion real del red-proof

## Diagrams

### Flujo SDD en ndomo

```d2
direction: right

spec: "SPEC-001\n.ndomo/specs/001-sdd-core/spec.md" {
  style.fill: "#e8f0fe"
  style.border: "#4285f4"
}

t_create: spec_create
t_lint: spec_lint
t_plan: "plan_create\nmetadata.specId"
t_approve: "plan_approve\nGATE T0: lint clean"
t_tasks: "task_create_batch\nmetadata.reqIds"
t_red: "test rojo\ntag REQ-xxx"
t_impl: "codigo -> verde -> refactor"
t_verify: "task_verify passed\nGATE T1: redProof + testRefs"
t_close: "plan completed\nchangelog de la spec"

t_create -> t_lint -> t_plan -> t_approve -> t_tasks -> t_red -> t_impl -> t_verify -> t_close
spec -> t_lint: "SSOT"
t_approve -> t_lint: "re-lint en cada approve"

```

## Open Questions

- ¿El red-proof debe ejecutarse de verdad (harness que corre el test antes de implementar) o la evidencia adjunta es suficiente en v1?
- ¿Promover specs a tabla cuando exista busqueda cross-spec real, o mantener los archivos como canon?

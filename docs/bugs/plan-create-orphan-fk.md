# Bug: Plan orphaned in `draft` — `plan_approve` / `plan_update_status` fail with FK session validation

## Resumen

Planes creados mediante `plan_create` no pueden transicionar a `approved` ni a ningún estado terminal porque `plan_approve` y `plan_update_status` validan que `ctx.sessionID` exista en la tabla `sessions` (`src/db/plans.ts:118-121`, `src/db/plans.ts:159-162`). Dicho ID nunca se inserta en `sessions` porque corresponde a la sesión del harness (OpenCode), no a un `session_start` explícito. El plan queda bloqueado permanentemente en `draft`.

## Entorno

| Atributo | Valor |
|---|---|
| Sistema | ndomo plugin (OpenCode) |
| Fecha de detección | 2026-06-19 |
| Plan afectado | `7e6659fd-1e54-415d-84d5-ca52804145c5` / `test-plan-creation-2026-06-19` |
| Sesión smoke test | `ses_test_smoke_2026-06-19` |
| Sesión OpenCode (no insertada) | `ses_11ef21ff8ffeC9CTJhd8nlcgBP` |
| Estado actual del plan | `draft` (irreversible) |

## Reproducción

1. Crear plan:
   ```
   plan_create({slug: "test-plan-creation-2026-06-19", title: "...", overview: "..."})
   ```
   → Plan creado en status `draft`.

2. Crear tareas (opcional, no interfiere):
   ```
   task_create_batch({planId: "7e6659fd-...", tasks: [...]})
   ```
   → `task_create_batch` funciona correctamente (no valida sessionId).

3. Intentar aprobar:
   ```
   plan_approve({id: "7e6659fd-1e54-415d-84d5-ca52804145c5"})
   ```
   → Error:
   ```
   ndomo: session_id does not exist: ses_11ef21ff8ffeC9CTJhd8nlcgBP
   ```

4. Intentar cerrar (alternativa, mismo error):
   ```
   plan_update_status({id: "7e6659fd-...", status: "completed"})
   ```
   → Error idéntico:
   ```
   ndomo: session_id does not exist: ses_11ef21ff8ffeC9CTJhd8nlcgBP
   ```

## Comportamiento esperado vs observado

| Operación | Esperado | Observado |
|---|---|---|
| `plan_approve` | Plan transiciona a `approved` con `approved_at` seteado | Error `session_id does not exist`; plan permanece `draft` |
| `plan_update_status` | Plan transiciona a `completed`/`failed`/`abandoned` y se auto-archiva | Error `session_id does not exist`; plan permanece `draft` |
| Auto-archive en terminal status | Markdown generado en `<project>/.ndomo/archives/plans/` | Nunca se invoca (bloqueado por error previo) |

## Causa raíz

El bug es un side-effect del **Fix #1** (validación FK de `session_id` introducida para integridad referencial entre `plans` y `sessions`). Las tools MCP pasan `ctx.sessionID` (ID de sesión interno del harness OpenCode) como `opts.sessionId` a las funciones de transición:

- `plan_approve` → `src/plugin.ts:649-651`: llama `approvePlan(db, args.id, {sessionId: ctx.sessionID, ...})`.
- `plan_update_status` → `src/plugin.ts:672-675`: llama `updatePlanStatus(db, args.id, args.status, {sessionId: ctx.sessionID, ...})`.

Ambas funciones en `src/db/plans.ts` ejecutan la validación FK:

- `updatePlanStatus` → `src/db/plans.ts:118-121`: `SELECT 1 FROM sessions WHERE id = ?` — si no existe fila, lanza error.
- `approvePlan` → `src/db/plans.ts:159-162`: idéntica validación.

La tabla `sessions` solo recibe filas mediante `session_start` explícito (`src/db/sessions.ts:24-38`). El `ctx.sessionID` del harness OpenCode (`ses_11ef21ff8ffeC9CTJhd8nlcgBP`) **nunca es insertado** en `sessions`. Por tanto, cualquier transición de estado que pase `ctx.sessionID` falla.

`plan_create` no se ve afectado porque su implementación no valida `sessionId` contra la tabla (`src/plugin.ts:556-592`). `task_create_batch` tampoco valida — solo pasa `planId`.

## Workarounds

1. **Ninguno desde user-side**: El harness OpenCode no expone control sobre `ctx.sessionID`, por lo que no es posible invocar `session_start` con un ID que coincida antes de `plan_approve`.

2. **SQL directo (acceso a DB)**: Si se tiene acceso al archivo `.ndomo/state.db`, se puede insertar manualmente la fila faltante:
   ```sql
    INSERT INTO sessions (id, started_at, last_checkpoint, goal, state, agent_history)
    VALUES ('ses_11ef21ff8ffeC9CTJhd8nlcgBP', 1729300000000, 1729300000000, 'fix orphan plan FK', '{}', '[]');
   ```
   Luego `plan_approve` y `plan_update_status` funcionarán. No es aplicable en producción / entorno multi-agente.

3. **No recomendado**: Deshabilitar la validación FK localmente editando `src/db/plans.ts`. Rompe la integridad referencial y se pierde en el próximo pull.

## Fix propuesto

Tres opciones, ordenadas por impacto/costo descendente:

### a) Auto-insertar fila en `sessions` al primer `plan_create`

Capturar `ctx.sessionID` en `plan_create` e insertar automáticamente un registro en `sessions` si no existe. Zero-touch para el usuario. Garantiza que toda tool posterior que use el mismo `ctx.sessionID` encuentre la fila. Costo: ~5 líneas en `src/plugin.ts:plan_create`.

### b) Relajar validación con upsert automático (lazy)

En `approvePlan` y `updatePlanStatus`, si `opts.sessionId` no existe en `sessions`, hacer un `INSERT OR IGNORE` automático antes de la transición. Similar a (a) pero diferido al momento de la primera transición. Menos intrusivo, pero permite que se cree la fila sin goal ni metadata.

### c) Documentar requisito de `session_start` previo

Exigir que toda transición de plan esté precedida por un `session_start` explícito en el mismo flujo. Workaround oficial pero no práctico para el foreman — añade un paso manual frágil.

**Opción recomendada**: (a) por simplicidad y cobertura total del lifecycle.

## Impacto

- Todo plan creado por el foreman (o cualquier agente) en una sesión de OpenCode sin `session_start` previo queda bloqueado en `draft`.
- La DB acumula planes `draft` no cerrables que nunca reciben auto-archive.
- El `plan_update_status` con status terminal (`completed`, `failed`, `abandoned`) nunca se ejecuta, por lo que el auto-archive a markdown (`src/plugin.ts:677-688`) no se dispara.
- El lifecycle de 10 pasos del foreman (`docs/database.md:202-219`) se rompe en el paso 3 (`plan_approve`).
- No hay pérdida de datos — los planes existen en DB — pero no se pueden gestionar programáticamente.

## Referencias

- Código tool MCP `plan_approve`: `src/plugin.ts:644-655`
- Código tool MCP `plan_update_status`: `src/plugin.ts:657-689`
- Validación FK en `updatePlanStatus`: `src/db/plans.ts:117-121`
- Validación FK en `approvePlan`: `src/db/plans.ts:158-162`
- Inserción de sesiones solo vía `session_start`: `src/db/sessions.ts:24-38`
- Tool MCP `plan_create`: `src/plugin.ts:556-592`
- Plan afectado: `7e6659fd-1e54-415d-84d5-ca52804145c5` / `test-plan-creation-2026-06-19`
- Sesión OpenCode no insertada: `ses_11ef21ff8ffeC9CTJhd8nlcgBP`
- Mensaje original del error: `msg_ee10e0bab001kwzDMkf5gpxY7T`

## Status

| Campo | Valor |
|---|---|
| Estado | `Detected` |
| Workaround | `none user-side` |
| Fix | `pending` |

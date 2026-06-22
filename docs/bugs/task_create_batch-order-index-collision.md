# Bug: `task_create_batch` UNIQUE constraint collision on retries/splits

## Resumen

`task_create_batch` falla con `UNIQUE constraint failed: plan_tasks.plan_id, plan_tasks.order_index` cuando el caller invoca la tool 2+ veces para el mismo plan (retry post-abort, dispatch cross-step, o re-creación tras abort). El bug también se manifiesta en splits cross-stack cuando los decimales generados colisionan con order_indices existentes.

## Entorno

| Atributo | Valor |
|---|---|
| Sistema | ndomo plugin (OpenCode) |
| Fecha de detección | 2026-06-22 |
| Plan de evidencia | `18252705-9c4e-4f5b-85a8-4f7153ceb101` |
| Plan de fix | `ca69222a-808a-41b0-9dae-05f7641be308` |
| Sesión de fix | `ses_craftsman_ca69222a` |
| Archivos afectados | `src/db/tasks.ts`, `tools/task_create_batch.ts`, `src/plugin.ts` |

## Reproducción

1. Crear plan y poblar con 1 task (1ra invocación de `task_create_batch`):
   ```
   plan_create({slug: "feat-x", title: "...", overview: "..."})
   task_create_batch({planId: "...", tasks: [{description: "task 0", agent: "craftsman"}]})
   ```
   → Task creada en `order_index=0`. OK.

2. Invocar `task_create_batch` nuevamente para el mismo plan (2da invocación):
   ```
   task_create_batch({planId: "...", tasks: [
     {description: "task A", agent: "craftsman"},
     {description: "task B", agent: "js-smith"},
     ...
   ]})
   ```
   → Error:
   ```
   UNIQUE constraint failed: plan_tasks.plan_id, plan_tasks.order_index
   ```

3. El bug también ocurre en splits cross-stack: si un task con files multi-stack genera sub-tasks con `orderIndex = parentOrder + 0.1 * stackIdx`, los decimales pueden colisionar con order_indices existentes.

## Comportamiento esperado vs observado

| Operación | Esperado | Observado |
|---|---|---|
| 2da invocación de `task_create_batch` | Nuevas tasks asignadas a order_index secuenciales sin colisión | `UNIQUE constraint failed` — transacción abortada |
| Split cross-stack con decimales ocupados | Sub-tasks reasignadas a slots libres | `UNIQUE constraint failed` si decimal colisiona |
| Caller pasa `orderIndex` explícito que colisiona | Core reasigna a slot libre | `UNIQUE constraint failed` |

## Causa raíz

Doble causa: callers + core confiaban en `orderIndex` del caller sin validación contra DB existente.

### Caller: `orderIndex: idx` forzado

Los callers en `tools/task_create_batch.ts:47` y `src/plugin.ts:965` pasaban `orderIndex: idx` desde `array.map((t, idx) => ...)`:

```typescript
// tools/task_create_batch.ts (ANTES del fix)
args.tasks.map((t, idx) => ({
  orderIndex: idx,  // ← solo único intra-batch, no considera tasks existentes
  ...
}))
```

`idx` es 0, 1, 2... dentro del batch, pero no considera tasks ya persistidas en el plan. En la 2da invocación, `idx=0` colisiona con la task existente en `order_index=0`.

### Core: `createTasksBatch` confiaba en caller's `orderIndex`

`src/db/tasks.ts:createTasksBatch` usaba `effectiveTask.orderIndex ?? i` como autoridad directa para el INSERT, sin validar contra `plan_tasks` existentes:

```typescript
// src/db/tasks.ts (ANTES del fix)
const orderIndex = effectiveTask.orderIndex ?? i;
db.query(`INSERT INTO plan_tasks ... VALUES (...)`).run(id, planId, orderIndex, ...);
```

Sin pre-loop `SELECT MAX(order_index)`, sin set de order_indices usados, sin retry on UNIQUE violation.

### Split cross-stack: decimales sin validación

El split M7 generaba `orderIndex = (t.orderIndex ?? results.length) + stackIdx * 0.1` sin verificar si los decimales ya existían en la DB.

## Workaround histórico

Mientras el fix no estaba aplicado, el foreman usó INSERT directo via `bun:sqlite` con `order_index` explícito pre-calculado desde `MAX+1`:

```typescript
const db = new Database('.ndomo/state.db');
const maxRow = db.query("SELECT MAX(order_index) as m FROM plan_tasks WHERE plan_id = ? AND archived_at IS NULL").get(planId);
let order = (maxRow?.m ?? -1) + 1;
// for each task: INSERT with order_index=order++ en transacción
```

4 tasks del plan `ca69222a` fueron creadas via este workaround. Sus metadatos fueron actualizados con `{bugWorkaroundApplied: true, bugSlug: "task_create_batch-order-index-collision", originalInsertMethod: "bun-sqlite3-direct", fixedIn: "ca69222a-..."}`.

## Fix aplicado

**Estrategia**: defense-in-depth en `createTasksBatch` — el core es la autoridad para `order_index`, no el caller.

### Cambios en `src/db/tasks.ts:createTasksBatch`

1. **Pre-loop `SELECT MAX(order_index)`**: calcula `nextFreeInteger` desde el MAX de tasks no-archived.
2. **`usedOrderIndices` set**: recolecta TODOS los order_indices existentes (incluyendo archived) para collision detection. El `UNIQUE(plan_id, order_index)` no filtra por `archived_at`.
3. **`allocateOrderIndex(preferred)` helper**: intenta el slot preferido del caller; si está ocupado o undefined, cae a `nextFreeInteger` e incrementa hasta encontrar slot libre.
4. **`allocateSplitOrderIndex(parentOrder, stackIdx)` helper**: `stackIdx=0` → parentOrder (ya alocado); `stackIdx>0` → `parentOrder + stackIdx * 0.1`; si decimal ocupado → escala a siguiente integer libre.
5. **Try/catch SQLITE_CONSTRAINT UNIQUE con retry**: defense-in-depth — si una race condition o edge case produce colisión, reasigna y reintenta (hasta 10 intentos).
6. **Signature change**: `orderIndex` ahora es optional en el input type (`Omit<PlanTask, ... | "orderIndex"> & { orderIndex?: number }`).

### Cambios en callers

- `tools/task_create_batch.ts`: eliminado `orderIndex: idx` del `.map()`.
- `src/plugin.ts`: eliminado `orderIndex: idx` del `.map()`.

Los callers ahora pasan `orderIndex: undefined` (implícito), y el core aloca dinámicamente.

## Tests de regresión

7 tests añadidos a `src/db/tasks.test.ts`:

| Test | Escenario |
|---|---|
| (a) | Plan pre-poblado (task en 0) + nueva task con `orderIndex=0` → reasigna a 1 |
| (b) | Split cross-stack con plan pre-poblado → parent=1, decimal=1.1 |
| (c) | Split cross-stack con decimales ocupados (0.1, 0.2) → escala a integers 1, 2 |
| (d) | Caller pasa `orderIndex` colisionante → core reasigna |
| (e) | Reproduce bug exacto: 1st batch OK, 2nd batch 4 tasks con `orderIndex` colisionante → todas reasignadas |
| (f) | Caller omite `orderIndex` → core asigna secuencial desde MAX+1 |
| (g) | Archived task ocupa slot → nueva task evita colisión |

## Lección replicable

> Any tool que mapea `array → unique-constraint-key` es unsafe para re-invocación sobre mismo parent. Always: lookup current max/sequence BEFORE generating keys, never trust caller-provided sequential indices.

El patrón `array.map((item, idx) => ({ orderIndex: idx, ... }))` es seguro solo intra-batch. Para safety cross-batch, el core debe:
1. Query DB state antes de generar keys
2. Tratar caller-provided keys como hints, no como autoridad
3. Retry on constraint violation con reasignación

## Referencias

- Schema constraint: `src/db/schema.ts:53` — `UNIQUE(plan_id, order_index)`
- Core fix: `src/db/tasks.ts:createTasksBatch` — pre-loop MAX + allocateOrderIndex + allocateSplitOrderIndex + try/catch retry
- Caller fix (tools): `tools/task_create_batch.ts:44` — eliminado `orderIndex: idx`
- Caller fix (plugin): `src/plugin.ts:962` — eliminado `orderIndex: idx`
- Tests: `src/db/tasks.test.ts` — describe "order_index collision-safe allocation"
- Plan de fix: `ca69222a-808a-41b0-9dae-05f7641be308`
- Plan de evidencia: `18252705-9c4e-4f5b-85a8-4f7153ceb101`

## Status

| Campo | Valor |
|---|---|
| Estado | `Resolved` |
| Workaround | `bun:sqlite direct INSERT con order_index manual` (obsoleto post-fix) |
| Fix | `ca69222a-808a-41b0-9dae-05f7641be308` — applied 2026-06-22 |
| Tests | 7 regression tests — 49/49 pass (42 existing + 7 new) |
| Suite | 356/356 pass (full project) |

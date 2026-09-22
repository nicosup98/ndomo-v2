# Design: Migración OpenCode v2 + Integración jev (TypeSafe AI) para routing de agentes

- **Fecha:** 2026-09-21
- **Autor:** foreman (Master Orchestrator)
- **Estado:** approved
- **Planes vinculados:**
  - Plan A: `opencode-v2-migration` — id `cde53800-a233-4448-b6af-33e87235e3d6` (approved, priority 1)
  - Plan B: `jev-routing-integration` — id `c3677bd4-2b01-498b-aec1-b6e4cefa7baa` (draft, blocked by Plan A, priority 3)

---

## 1. Problema

1. **OpenCode v2** es una actualización mayor: la API de plugins v1 (`@opencode-ai/plugin`) **no corre en v2**. Todo el ecosistema ndomo (plugin core ~1340 líneas con ~30 tools, hooks, SDK client, CLI, HTTP server, web UI, flujo de instalación) está construido sobre v1 y queda inoperante.
2. **Enrutamiento de tareas**: hoy `routeTask()` (src/orchestrator/scheduler.ts) usa 11 reglas heurísticas priorizadas + `STACK_AGENTS` (stack→smith). No aprende de contexto semántico ni de histórico; el objetivo es integrar **jev** (TypeSafe AI, SDK `@typesafe-ai/sdk`) para clasificar tareas → agente con ML.

## 2. Decisiones tomadas (grilling, 2026-09-21)

| # | Pregunta | Decisión |
|---|---|---|
| 1 | Alcance migración v2 | **Todo el ecosistema**: plugin.ts + tools/ + sdk/client.ts + cli/ + config/ + web/ + http/. web/http pueden ir después del núcleo. |
| 2 | Secuencia | **v2 primero, jev después** (evita doble re-trabajo sobre scheduler/plugin). |
| 3 | Estrategia jev | **ML-first con fallback rules**: jev clasifica task→agente; fallo/timeout/baja confianza → `routeTask()` actual. Cero riesgo operativo. |
| 4 | Choice set jev | **Solo primary peers** (foreman/ranger/craftsman/warden). El peer luego elige specialist con sus tablas internas. |
| 5 | Entorno jev | **Key de producción** typesafe.ai (`TYPESAFE_API_KEY` disponible). |

## 3. Opciones evaluadas

### 3.1 Estrategia de migración v2

| Opción | Pros | Contras | Veredicto |
|---|---|---|---|
| **A. Clean break v2** | Código simple, una sola API, sin deuda | Rompe opencode 1.x | ✅ **Elegida** (default) |
| B. Dual-support (`server()` v1 + `Plugin.define` v2) | Transición sin downtime en 1.18.29+ | Doble superficie de hooks, doble mantenimiento, APIs no se auto-traducen | Fallback si auditoría detecta target 1.x |

**Rationale:** el usuario pidió explícitamente "pasa a v2"; mantener v1 duplica el trabajo de migración sin beneficio claro. La auditoría de ranger (Plan A task 0) confirma la versión target; si detecta que la instalación activa aún corre 1.x, se reevalúa dual-support.

### 3.2 Integración jev

| Opción | Pros | Contras | Veredicto |
|---|---|---|---|
| A. Rules-only (status quo) | Cero riesgo, sin dependencia externa | No aprende, no escala con complejidad | Descartada como única |
| B. ML-only | Máxima simplicidad conceptual | Un fallo/timeout de red bloquea dispatch; dependencia dura de API externa | Descartada |
| **C. ML-first + fallback rules** | Mejor de ambos; degradación elegante; auditable | Complejidad del wiring | ✅ **Elegida** |

**Rationale:** jev aporta clasificación semántica; `routeTask()` ya funciona y cubre el 100% de casos como fallback. El riesgo operativo de C es ≈ el de A, con upside de B.

### 3.3 Granularidad del choice set

Solo primary peers (4 choices) — no smiths. Razón: los smiths son specialists internos de craftsman/warden; jev a nivel peer mantiene el contrato arquitectónico (foreman planifica, peers ejecutan, peers eligen specialists). Choice set pequeño = mayor precisión de clasificación.

## 4. Arquitectura objetivo (v2)

### 4.1 Migración plugin (mapping v1→v2 aplicado)

| v1 (actual) | v2 (target) |
|---|---|
| Entrypoint `Plugin` (objeto con hooks) | `Plugin.define({ id: "ndomo", async setup(ctx) {...} })` + cleanup fn |
| `experimental.session.compacting` | `ctx.session.hook("compaction")` (event.messages; `event.result` para skip model call) |
| `tool.execute.before/after` | `ctx.tool.hook("execute.before" / "execute.after")` |
| `shell.env` | `ctx.shell.hook("create.before")` (event.env mutable) |
| Tool map (~30 tools) | `ctx.tool.transform(editor => editor.add({name, description, input: JSONSchema, execute}))` |
| `directory` / `project` | `ctx.location.directory` / `ctx.location.project` |
| client (SDK v1) | domain methods (`ctx.session`, `ctx.permission`, `ctx.agent`, `ctx.tool`, …) |
| `options` arg | `ctx.options` |
| returned `dispose()` | cleanup fn retornada por `setup` |
| returned event hook | `ctx.event.subscribe({signal})` |
| `opencode.json` key `plugin` | key `plugins` (entries: string \| `{package, options}`) |

**Sin equivalente directo v2** (re-evaluar contra session/provider/model/event APIs): `experimental.compaction.autocontinue`, `experimental.provider.small_model`, `experimental.text.complete`.

### 4.2 jev router (Plan B)

```
routeTask(task)
  ├─ jev.enabled && TYPESAFE_API_KEY?
  │    ├─ TypeSafeClient.systemOne({ state: {descripción, files/stack hints, contexto}, questions: { peer: choice("¿A qué peer corresponde?", {foreman, ranger, craftsman, warden}) } })
  │    ├─ ok && confidence >= minConfidence → RoutingDecision(source: "jev", peer)
  │    └─ timeout | error | baja confianza → fallback ↓
  └─ fallback: routeTask() rules actuales (source: "rules"; mapeo smith→peer vía delegates_to)
  → registrar decisión (source, latency, choice, confidence) en DB para auditoría
```

Config nueva: `jev.enabled`, `jev.timeoutMs`, `jev.minConfidence` (ndomo.config.json + env `TYPESAFE_API_KEY`).

## 5. Alcance y exclusiones

**Incluido:**
- Migración v2 completa (plugin core → superficie externa → web/http → ops/verificación e2e).
- jev ML-first routing con fallback + auditoría de decisiones + tests con mock (sin red en CI).

**Excluido / diferido:**
- Dual-support v1/v2 (solo si auditoría lo justifica).
- Migración de datos históricos (DB SQLite se mantiene igual).
- Fine-tuning / prompts custom de jev (se usa `choice()` estándar del SDK 0.6.0).
- Cambios de modelo de negocio en web UI (solo adaptación del API client).

## 6. Fases

**Plan A — opencode-v2-migration** (5 tasks):
0. `ranger` — auditoría v1→v2 + research paquete client v2/instalación + decisión dual-support.
1. `craftsman` — plugin core `src/plugin.ts` → `Plugin.define` + transforms + hooks.
2. `craftsman` — tools/*.ts + sdk/client.ts + cli/ + config/ + install flow.
3. `craftsman` — web/ + http/ (diferible post-núcleo).
4. `warden` — deps/CI/Docker/smoke + verificación e2e (checklist migrate-v1).

**Plan B — jev-routing-integration** (4 tasks, inicia solo tras Plan A):
0. `craftsman` — módulo `src/orchestrator/jev-router.ts`.
1. `craftsman` — wiring ML-first en `routeTask()` + registro de decisiones.
2. `craftsman` — tests (cliente mockeado, sin red).
3. `warden` — ops (secret, schema config, docs).

## 7. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| API v2 aún cambiante / docs incompletas | Alto | Auditoría ranger fase 0 contra docs oficiales + gaps documentados |
| Instalación v2 (plugins key, file: dep) rompe flujo actual | Medio | Task 2 incluye install flow; task 4 verifica instalación limpia (paquete instalado, no workspace link) |
| Hooks sin equivalente v2 (compaction autocontinue, small_model, text.complete) | Medio | Documentar gap + re-evaluar contra APIs session/provider/event; degradación explícita |
| jev API externa (latencia/costos/disponibilidad) | Medio | ML-first con fallback rules + timeout + umbral confianza; key prod |
| Doble re-trabajo si jev se integra antes de v2 | Alto | Secuencia estricta: Plan B bloqueado por Plan A |
| Split automático de tasks cross-stack en `createTasksBatch` (M7) reasigna agente a smiths | Bajo | Documentado: tasks de plan con >1 file multi-stack se dividen con STACK_AGENT_MAP; para tasks peer-level pasar 1 file o none |

## 8. Open questions (a resolver en Plan A task 0 — ranger)

1. Nombre exacto del paquete client v2 (¿`@opencode/client`?) para `src/sdk/client.ts`, `src/http/`, `web/`.
2. Mecánica de instalación v2: `plugins` key en `~/.config/opencode/opencode.json` + entries string vs `{package, options}`; auto-load local desde `.opencode/plugins/`; cómo se resuelve el paquete publicado `ndomo` vs `file:` dep.
3. Versión opencode target instalada → decidir dual-support vs clean break.
4. ¿`ctx.tool.transform` soporta tools con execute de larga duración / background dispatch (BackgroundDispatcher)? ¿`ctx.session.hook("compaction")` cubre el comportamiento de auto-checkpoint actual?

## 9. Verificación (checklist migrate-v1)

- [ ] plugin id/source presente en lista de plugins activos.
- [ ] Todos los hooks/transforms/tools/commands/subscriptions ejercitados.
- [ ] Cleanup verificado on reload.
- [ ] Options + estado persistido probados en proyecto limpio.
- [ ] Paquete instalado (no workspace link) probado end-to-end.

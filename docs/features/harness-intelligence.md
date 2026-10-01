# Feature: Harness Intelligence Pack — routing con historial + JEV Score · Agent Scorecard · Self-Audit

**Slug:** `harness-intelligence-pack`
**Status:** Implemented (v1, post-merge)
**Plan ID:** `e1afae99-8ca5-4908-a28b-9a056cc6dd42`
**Plan slug:** `harness-intelligence-pack`
**Created:** 2026-09-30
**Design doc:** `.ndomo/designs/2026-09-30-harness-intelligence-pack-design.md`
**Commits:** F1 `05e7574`, F2 `10dc2fd`, F2.1 `6c3c78f`, F3 `faa0a3`, F3.1 `1c9c027`
**Fase 2 — History cache:** plan `fbaafcdd-7e8e-41a5-ba9e-d01abb6c1d0e` (`routing-history-cache`) — commit `190c3f1`

---

## 1. Resumen ejecutivo

Pack de inteligencia de harness que añade tres capacidades al orquestador de ndomo, sin migraciones de DB:

| # | Pieza | Superficie | Entrada |
|---|-------|-----------|---------|
| F1 | **History-aware routing** | tool MCP `route` (`src/plugin.ts:955-987`) + `routeTask` (`src/orchestrator/scheduler.ts:446`) | `src/orchestrator/agent-history.ts` (nuevo) |
| F2 | **Agent Scorecard** | CLI `ndomo stats` (`src/cli/stats.ts`) + tool MCP `stats` (`src/plugin.ts:1456`) | `src/stats/agent-scorecard.ts` (nuevo) |
| F3 | **Self-Audit** | CLI `ndomo audit` (`src/cli/audit.ts`) | `src/audit/*` (nuevo) |

**Restricción transversal:** sin tablas nuevas, sin migraciones. F1 lee el historial on-the-fly desde `plan_tasks`; F2 agrega las mismas filas; F3 audita la instalación (frontmatter, permisos, conteos, config, manifest). Toda la señal histórica degrada a la heurística previa si no hay datos suficientes.

**Inspiración:** agentic-flow (self-learning hooks, route/metrics) y ruflo (MetaHarness audit grade 1-100).

---

## 2. F1 — History-aware routing

### 2.1 Qué hace

`routeTask` recibe una tarea (`description`, `type`, `stack`, `risk`, `files`) y devuelve un `RoutingDecision` enriquecido. Sin historial se comporta exactamente como el router previo (heurística + JEV). Con historial, re-rankea el pool de candidatos usando outcomes reales de `plan_tasks`.

El historial se construye por llamada con `loadAgentHistory(db)` (`src/orchestrator/agent-history.ts:376`) y se inyecta en `routeTask` como `options.history` (`src/plugin.ts:983`).

### 2.2 Bucketing: `intent:stack`

El bucket de una tarea es `intent:stack` (`bucketForTask`, `src/orchestrator/agent-history.ts:241`).

**Intent** — derivado del agente que ejecutó la fila histórica (`intentForAgent`, `:195`) o del `type` de la tarea entrante:

| Agente | Intent |
|--------|--------|
| `scout`, `ranger`, `ops-scout` | `explore` |
| `chronicler` | `document` |
| `scribe` | `research` |
| `painter` | `design` |
| `inspector`, `critic` | `audit` |
| `guild` | `debate` |
| `sage` | `debug` |
| resto | `implement` |

**Stack** — derivado de las extensiones de `files` (`stackFromFiles`, `:200`); si no resuelve a un stack conocido, cae al `stack` declarado y luego a `generic` (`stackBucketForTask`, `:228`):

| Extensiones | Stack |
|-------------|-------|
| `.vue` | `vue` |
| `.go` | `go` |
| `.py` | `python` |
| `.rs` | `rust` |
| `.zig` | `zig` |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | `js` |
| `.md`, `.mdx`, `.txt` | `docs` |
| (vacío / sin match) | `generic` |

Empates entre stacks se resuelven con orden fijo `vue → go → python → rust → zig → js → docs` (`STACK_TIE_ORDER`, `:181`).

### 2.3 Score por candidato

Para cada candidato, `scoreAgentForBucket` (`:441`) calcula un producto de factores:

```
score = pooledBeta × recency × verify × duration × jevConfidence
```

| Factor | Fórmula / semántica | Neutral |
|--------|---------------------|---------|
| `pooledBeta` | `betaMean` jerárquico celda → agente → global, con blending por `MIN_CELL_N = 5` (`blendWithParent`, `:432`) | — |
| `recency` | EWMA half-life 30 días: `0.5 ^ (ageDays / 30)` | `0` si no hay `lastCompletedAt` |
| `verify` | `passRate = passed / (passed + waived)`; alta complejidad `0.6 + 0.4·rate`, baja `0.7 + 0.3·rate` | `1.0` sin muestras |
| `duration` | `raw = 1 / (1 + p50 / baseline)`; alta complejidad `0.8 + 0.2·raw`, baja `0.7 + 0.3·raw` | `1.0` sin baseline |
| `jevConfidence` | `0.5 + 0.5·clamp01(JEV confidence)` | `1.0` (⇒ factor `1.0`) |

El factor de recency entra multiplicado como `0.5 + 0.5·recency` (`:488`). El score final se clampa a `[0,1]`.

**Priors bayesianos** (`HISTORY_PRIORS`, `:50`) — cada nivel tiene media `1/3`:

| Nivel | α | β |
|-------|---|---|
| `cell` | 1 | 2 |
| `agent` | 2 | 4 |
| `global` | 4 | 8 |

**Complejidad:** el umbral `HIGH_COMPLEXITY_THRESHOLD = 0.66` (`:56`) decide qué rama de `verify`/`duration` aplica.

### 2.4 Semántica de éxito y muestreo

`successValue` mapea cada outcome terminal a un valor (`SUCCESS_WEIGHT` espeja esta semántica en F2, `src/stats/agent-scorecard.ts:38`):

| Outcome | Valor |
|---------|-------|
| `done` + `verification_status = 'passed'` | `1.0` |
| `done` + `waived` | `0.5` |
| `done` sin verificación | `0.8` |
| `failed` | `0` |
| `pending` / `running` / `blocked` | excluidos |

- Cap de `100` filas por celda (`HISTORY_MAX_ROWS_PER_CELL`, `:46`), las más recientes por `completed_at` desc.
- Duración por fila = `duration_ms ?? (completed_at − started_at)`.
- Se incluyen planes/tasks archivados; el filtrado SQL deja solo `status IN ('done','failed')`.

### 2.5 JEV Score

`classifyRouteWithJev` (`src/orchestrator/jev.ts:333`) hace **UNA sola** request `systemOne` que responde 4 preguntas:

1. `agent` (choice entre `ranger`/`craftsman`/`warden`)
2. `type`
3. `risk` (`low`/`medium`/`high`)
4. `complexity` (score sobre `JEV_COMPLEXITY_CRITERIA`, `:265` — 4 niveles)

La complejidad se normaliza dividiendo por `len(criteria) − 1 = 3` (`pickScore`, `:291`), resultando en `[0,1]`. La `confidence` del agente se extrae con `pickConfidence` (`:300`). Si JEV está deshabilitado, sin clave o con timeout, `classifyRouteWithJev` devuelve `null` y el routing degrada a reglas/historial sin JEV.

### 2.6 Output de `route` (aditivo)

`RoutingDecision` se extendió con campos aditivos (`src/orchestrator/scheduler.ts:37-48`):

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `source` | `"rules" \| "jev" \| "history" \| "hybrid"` | Señal que produjo la decisión |
| `confidence` | `number` | `top / (top + runnerUp)` (`:380`) |
| `alternatives` | `Array<{agent, score, reason}>` | Máx. 3, excluye el elegido (`:399-406`) |
| `explain` | `string[]` | Línea de historial + top-3 con cada factor |
| `fallback` | `boolean` | `true` si `cellN === 0 && agentN === 0` (cold start) (`:398`) |
| `explore` | `boolean?` | `true` cuando epsilon-exploration forzó la 2ª opción (`:424`) |
| `requiresReview` | `string?` | `"sage"` si `complexity >= 0.66` y el elegido no es `sage` (`:388-389`) |
| `historyCache` | `"hit" \| "miss" \| "bypass"` | Estado del memo route-only (fase 2); solo presente si el caller lo reporta (`scheduler.ts:51`) |

**Memo del historial (`historyCache`, fase 2):** el tool `route` consume el memo y reporta el estado (`plugin.ts:976-985`); `scheduler` solo lo añade si el caller lo reportó — como primera línea de `explain` (`historyCache: <state>`, `scheduler.ts:396-399`) y como campo del decision (`:436`). Sin reporte, el shape de `route` es byte-idéntico al de F1 (sin `historyCache`, sin cambio en `explain`).

**Epsilon-exploration:** `DEFAULT_EXPLORE_EPSILON = 0.15` (`:238`). Con probabilidad ε fuerza el segundo mejor candidato y marca `explore: true` (mitigación del feedback loop). `epsilon` y `random` son inyectables para tests.

**Fuente (`source`):** `"hybrid"` cuando hay JEV + historial; `"history"` con historial sin JEV; `"jev"` / `"rules"` sin historial.

### 2.7 Ejemplo de uso — tool `route` con `explain`

```typescript
route({
  description: "add JWT middleware to the auth route",
  type: "implement",
  files: ["src/auth/middleware.ts"],
  risk: "medium",
})
```

Salida (ejemplo ilustrativo; campos clave, recortada):

```json
{
  "agent": "js-smith",
  "source": "hybrid",
  "confidence": 0.71,
  "fallback": false,
  "alternatives": [
    { "agent": "craftsman", "score": 0.42, "reason": "score 0.420 (cellN=3, agentN=12)" }
  ],
  "explain": [
    "history: 200 terminal tasks; bucket=implement:js; candidates=js-smith, craftsman, smith",
    "* js-smith: score=0.735 pooled=0.612 recency=0.941 verify=1.000 duration=0.930 confidence=0.975 (cellN=7, agentN=18)",
    "  craftsman: score=0.420 pooled=0.401 recency=0.812 verify=1.000 duration=1.000 confidence=0.910 (cellN=3, agentN=12)"
  ]
}
```

`explain` expone bucket, `n` (cellN/agentN) y cada factor, permitiendo al consumidor entender por qué el historial re-rankeó (o no).

### 2.8 Fase 2 — History cache (TTL 30s)

Cada invocación del tool `route` re-escaneaba todas las filas terminales de `plan_tasks`: un scan O(n) que crece con el backlog del plan (`src/orchestrator/agent-history.ts:424-431`). La fase 2 añade un **memo route-only** in-process — `getAgentHistoryCached` (`:509`) — que reutiliza el último snapshot durante `HISTORY_CACHE_TTL_MS = 30_000` ms (`:448`).

#### Mecánica y semántica

| Aspecto | Detalle | Ref |
|---------|---------|-----|
| TTL | `HISTORY_CACHE_TTL_MS = 30_000` — ventana de frescura de un snapshot; expirado ⇒ reload (`miss`) | `agent-history.ts:448` |
| Estado reportado | `HistoryCacheState = "hit" \| "miss" \| "bypass"` | `:451` |
| Clave del memo | `file:<filename>` para DB on-disk (handles del mismo archivo comparten entrada); `memory:<id>` por handle `:memory:` vía WeakMap (`memoryDbIds`) — dos `:memory:` nunca comparten snapshot | `:487-499` |
| API | `getAgentHistoryCached(db, options): CachedAgentHistory { history, cache }` — hits devuelven la misma referencia de snapshot | `:463-468`, `:509-532` |
| Invalidación | `invalidateAgentHistoryCache(db?)`; sin argumento limpia todo el memo (aislamiento de tests) | `:541-547` |
| Exports (`src/lib.ts`) | `getAgentHistoryCached`, `invalidateAgentHistoryCache`, `HISTORY_CACHE_TTL_MS` + tipos `HistoryCacheState`, `AgentHistoryCacheOptions`, `CachedAgentHistory` | `src/lib.ts:17-37` |

Semántica de los tres estados:

| Estado | Ocurre cuando | Comportamiento |
|--------|---------------|----------------|
| `miss` | Sin entrada o TTL expirado | Ejecuta el full-scan y re-memoiza el snapshot |
| `hit` | Entrada más joven que el TTL | Reutiliza el snapshot memoizado (misma referencia de objeto) |
| `bypass` | Se inyecta `options.now` (reloj de test del loader) | Ni lee ni escribe el memo — `loadAgentHistory` se mantiene puro y determinista (`:513-515`) |

Garantías del memo (JSDoc `:432-445`):

- **Never-throw:** un load fallido degrada a `emptyAgentHistory()`, el fallback neutro documentado (`:524-529`); el memo sigue operativo tras el fallo.
- **Reloj inyectable:** `options.clock` (solo tests) reemplaza `Date.now()` para el envejecimiento del TTL; producción nunca lo setea (`:454-460`).
- **Scope single-process:** los lectores de otros procesos dependen del TTL; cada mutación exitosa en este proceso invalida al instante (`:443-444`).

#### Invalidación tras mutación exitosa

Los hooks mutadores de `plugin.ts` invalidan el snapshot del `db` **después** de una mutación exitosa; si la mutación lanza, la excepción corta el flujo y **no** se invalida:

| Tool | Comportamiento | Ref |
|------|----------------|-----|
| `plan_delete` | Invalida siempre tras `deletePlan` (la eliminación quita filas terminales) | `plugin.ts:1578-1579` |
| `task_update_status` | Invalida solo `if (result)` — una transición real (`:1773-1782`); transiciones sin cambio no invalidan | `:1782` |
| `task_verify` | Invalida tras `recordTaskVerification` (los veredictos alimentan el factor `verify`) | `:1828-1841` |

Wiring del tool `route`: `const { history, cache } = getAgentHistoryCached(db)` → `options.historyCache: cache` (`plugin.ts:976-985`).

#### Bench (N = 20_000 filas terminales)

`src/orchestrator/agent-history-cache.test.ts:233-345` — 20k filas terminales (`status IN ('done','failed')`) en DB on-disk, 10 corridas cold (memo dropeado entre mediciones) + 100 llamadas warm:

| Métrica | Gate duro (enforced) | Target de diseño (logueado) | Medido (dev 4-core) |
|---------|----------------------|------------------------------|---------------------|
| Cold p95 | `< 150 ms` (`COLD_P95_CI_SAFE_MS`, `:242`) — CI-safe: el full-scan es costo intrínseco de `loadAgentHistory` (comportamiento pre-cache) y varía con la máquina | `< 50 ms` (`COLD_P95_TARGET_MS`, `:235`) — solo impreso en el log del bench | p50 ~48-50 ms / p95 ~62-80 ms (el JSDoc del bench documenta ~49-73 ms p95 en caja 4-core, `:236-241`) |
| Hit p95 | `< 1 ms` (`:338`) | — | p50 ~0.001 ms / p95 ~0.003 ms |

Durante la implementación se probó iterar el full-scan con `.values()`/cursor para evitar materializar el resultado: **sin mejora medible**, así que `loadAgentHistory` quedó intacto (el memo solo envuelve el loader; la firma y semántica del historial pre-cache no cambian).

Nota: el snapshot memoizado capa por celda (`HISTORY_MAX_ROWS_PER_CELL`), así que `terminalRows` del snapshot es menor que N=20_000 aunque el scan recorra todas las filas (`:294-299`).

---

## 3. F2 — `ndomo stats` (Agent Scorecard)

### 3.1 Qué hace

Scorecard por agente construido desde `plan_tasks` (y `plans` para escalaciones/bypasses). El core vive en `src/stats/agent-scorecard.ts` (`computeAgentScorecard`, `:356`) y lo comparten el CLI y el tool MCP `stats` (`src/plugin.ts:1456`).

### 3.2 Métricas por agente

| Métrica | Detalle | Ref |
|---------|---------|-----|
| `counts` | `done` / `failed` / `blocked` / `running` / `pending` / `total` | `:53` |
| `successRate` | `0–100` (1 decimal) sobre filas `done`+`failed`; `null` si `n=0`. Usa la misma semántica de éxito que F1 | `:97` |
| `verify` | `passed` / `waived` / `n` / `passRate` (`0–100` o `null`) | `:63` |
| `duration` | `p50` / `p95` nearest-rank sobre `duration_ms ?? (completed_at − started_at)` | `:73` |
| `tokensUsed` | Σ `plan_tasks.tokens_used` en la ventana | `:102` |
| `failureModes` | Top 3 modos normalizados (primera línea, ~80 chars) de filas `failed` con `error` | `:81` |
| `escalations` | Stubs de plan con slug `escalation-%`, agrupados por `metadata.escalatedFrom` | `:87` |
| `bypasses` | Tasks + plans con `metadata.verificationBypass` | `:108` |

### 3.3 Flags

| Flag | Valores | Default | Descripción |
|------|---------|---------|-------------|
| `--since` | `7d` \| `30d` \| `all` | `all` | Ventana temporal (`SCORECARD_SINCE_VALUES`, `:28`) |
| `--agent` | `<name>` | — | Restringe todas las métricas a un agente |
| `--json` | — | — | Emite `ScorecardReport` como JSON |

Por defecto **incluye archivadas** (historial completo); `--since` filtra. El `ScorecardReport` (`:112`) incluye `since`, `windowStart` (epoch-ms o `null` para `all`), `generatedAt` y `agents[]`.

### 3.4 Ejemplo de uso

```bash
# Scorecard completo en tabla
ndomo stats

# Últimos 7 días, un solo agente, JSON para scripting
ndomo stats --since 7d --agent js-smith --json
```

Payload `--json` (ejemplo ilustrativo, recortado):

```json
{
  "since": "7d",
  "windowStart": 1790171000000,
  "generatedAt": 1790777000000,
  "agents": [
    {
      "agent": "js-smith",
      "counts": { "done": 12, "failed": 2, "blocked": 1, "running": 0, "pending": 0, "total": 15 },
      "successRate": 85.7,
      "verify": { "passed": 4, "waived": 1, "n": 5, "passRate": 80 },
      "duration": { "p50": 42000, "p95": 180000, "n": 14 },
      "tokensUsed": 210430,
      "failureModes": [{ "mode": "typecheck: Property 'x' does not exist", "count": 2 }],
      "escalations": [],
      "bypasses": 0
    }
  ]
}
```

---

## 4. F3 — `ndomo audit` (Self-Audit)

### 4.1 Qué hace

Self-audit **report-only** de la instalación. El runner `runAudit({ projectDir, updateManifest? })` (`src/audit/runner.ts:65`) ejecuta cinco checks, ordena los findings de forma determinista y calcula un score. La **única escritura** posible es `.ndomo/audit/manifest.json`, y solo con `--update-manifest`.

### 4.2 Checks

| # | Check | Fuente | Severidades |
|---|-------|--------|-------------|
| (a) | **Drift** frontmatter `agents/*.md` vs presets `config/ndomo.config.json` | `src/audit/drift.ts` | `drift.field` INFO; `drift.missing-file` / `drift.missing-preset` WARN |
| (b) | **Permisos inseguros** | `src/audit/permissions.ts` | bash wildcard allow ERROR; `write` en agente read-only ERROR; bloque `permission:` ausente en primary WARN |
| (c) | **Conteos** docs (`README.md`, `README.es.md`, `docs/`) vs realidad | `src/audit/counts.ts` | tools / agents / skills / migraciones |
| (d) | **Config** `config/ndomo.config.json` válido + keys conocidas | `src/audit/config.ts` | JSON inválido / keys desconocidas |
| (e) | **Manifest sha256** + diff vs baseline | `src/audit/manifest.ts` | `manifest.modified` WARN; `manifest.removed` WARN; `manifest.added` INFO; `manifest.first-run` INFO |

**Manifest (e):** hashea `agents/*.md`, todo `skills/` (recursivo), `config/ndomo.config.json` y `config/ndomo.schema.json`; claves POSIX-relativas ordenadas → JSON byte-estable (`src/audit/manifest.ts:37`). Reusa `sha256Hex` de `src/obsidian/fs.ts`.

### 4.3 Score y exit codes

```
score = max(1, 100 − 10·ERROR − 4·WARN − 1·INFO)
```

(`src/audit/score.ts:34`; pesos en `SEVERITY_WEIGHT`). Floor en `1` (`SCORE_FLOOR`), techo en `100` (`SCORE_CEILING`).

| Exit code | Condición |
|-----------|-----------|
| `0` | Cero findings `ERROR` (WARN/INFO no fallan el comando) |
| `1` | ≥1 finding `ERROR`, o invocación inválida |

### 4.4 Flags

| Flag | Descripción |
|------|-------------|
| `--json` | Emite `AuditReport` como JSON |
| `--update-manifest` | Re-baseline de `.ndomo/audit/manifest.json` (única escritura) |
| `--help`, `-h` | Muestra la ayuda |

### 4.5 Ejemplo de uso

```bash
# Reporte report-only (no escribe nada)
ndomo audit

# Re-baseline tras revisar un cambio legítimo
ndomo audit --update-manifest

# JSON para CI
ndomo audit --json
```

Salida humana (ejemplo ilustrativo, recortada):

```
NDOMO AUDIT — /home/tecnologia/ndomo-v2
manifest: .ndomo/audit/manifest.json (no baseline, N files tracked)

INFO (12)
  [drift.field] agents/js-smith.md
      model differs from preset "default"

score: 88/100 — 0 error, 0 warn, 12 info (12 findings)
```

### 4.6 Estado del repo

Al momento del cierre: **88/100**, `0 ERROR`, `0 WARN`, `12 INFO`. Realidad verificada: `62 tools`, `23 agents`, `25 skills`, `17 migraciones`.

---

## 5. Límites v1 / fase 2

### 5.1 Límites v1

| Límite | Detalle |
|--------|---------|
| **Reranking completo** | F1 re-rankea el pool completo de candidatos, no solo como tiebreaker/cold-start. El diseño original hablaba de tiebreaker top-3; los tests codifican el comportamiento más agresivo (hallazgo no bloqueante del inspector) |
| **Cache v1 (fase 2)** | Memo route-only in-process: TTL 30 s + invalidación tras mutación exitosa (§2.8). Límite restante: single-process — lectores de otros procesos esperan el TTL (30 s) tras una mutación externa |
| **Bucketing por extensión** | El stack se deriva de extensiones de archivo; un `.ts` en contexto Go se clasifica como `js` |
| **Sin tablas nuevas** | El historial es on-the-fly desde `plan_tasks`; no hay persistencia de decisiones de route ni de transiciones |
| **Sin accuracy / A-B** | No se registran las decisiones `route`, por lo que no hay medición de precisión ni experimentos A/B |
| **Cold start frecuente** | Con ~200 tasks / 12 agentes, `fallback: true` es común al inicio; pooling jerárquico acepta scores mayormente agente/global |
| **Verify casi sin uso** | `verify` es neutral (`1.0`) hasta que T1 se use más (histórico: 4 tareas verificadas) |

### 5.2 Fase 2 diferida

> **Hecho en fase 2 (cache route-only v1):** memo in-process TTL 30 s + invalidación tras mutación — ver §2.8.

- Tabla dedicada de historial / `routing_events` con migración y link a outcome → routing accuracy y A/B.
- Pattern Bank / ReasoningBank, workers auto-trigger, outcome-quality Score.
- Fit tiebreaker parametrizable (on/off configurable).
- `-fix` automático en audit (v1 es report-only).
- Extensiones de docs-refs check.

---

## 6. Archivos clave

| Archivo | Rol |
|---------|-----|
| `src/orchestrator/agent-history.ts` | Historial on-the-fly + scoring bayesiano jerárquico + memo route-only (fase 2) |
| `src/orchestrator/agent-history-cache.test.ts` | Tests del memo (miss/hit/TTL/bypass/keys) + bench 20k (fase 2) |
| `src/orchestrator/scheduler.ts` | `routeTask` history-aware, reranking, epsilon-explore, `requiresReview` |
| `src/orchestrator/jev.ts` | `classifyRouteWithJev` (1 request, 4 preguntas) |
| `src/plugin.ts` | Tool `route` (`:955-987`) + tool `stats` (`:1456`) |
| `src/stats/agent-scorecard.ts` | Core compartido del scorecard CLI + tool |
| `src/cli/stats.ts` | CLI `ndomo stats` |
| `src/cli/audit.ts` | CLI `ndomo audit` |
| `src/audit/*` | Runner + checks drift/permisos/conteos/config/manifest + score |
| `docs/workflows.md` | Nota de routing history-aware (link a este doc) |

## 7. Referencias

- Design doc: `.ndomo/designs/2026-09-30-harness-intelligence-pack-design.md`
- Schema DB / `plan_tasks`: [docs/database.md](../database.md)
- Flujos de orquestación: [docs/workflows.md](../workflows.md)
- Feature anterior (craftsman/foreman): [feature-flexible-builder.md](feature-flexible-builder.md)

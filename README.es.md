# ndomo

Plugin multi-agente para OpenCode. Taller de artesanos: 23 agentes — 4 primarios (Foreman/Craftsman/Warden/Ranger) + 19 especialistas. Nativo en caveman. Memoria embedded (bun:sqlite + FlexSearch). Capa Obsidian. DCP peer opcional.

## Qué es ndomo

ndomo es un plugin de orquestación multi-agente para [OpenCode](https://github.com/opencode-ai). Enruta tareas de desarrollo a 23 agentes: 4 primarios (Foreman — planificación, Craftsman — implementación, Warden — operaciones, Ranger — sensado y análisis) y 19 especialistas (scout, scribe, painter, smith, go-smith, js-smith, python-smith, vue-smith, zig-smith, rust-smith, sage, guild, inspector, critic, chronicler, ci-smith, deploy-smith, release-smith, ops-scout). Todos los agentes usan el protocolo de salida Caveman para comunicación eficiente en tokens. La persistencia de memoria entre sesiones la gestiona el store de memoria embedded de ndomo (bun:sqlite + FlexSearch, una DB SQLite por proyecto). Los planes, tareas y sesiones viven en una state DB local al proyecto (SQLite + FTS5), y la capa Obsidian puede proyectar planes, tareas, designs y memorias de forma unidireccional hacia un vault externo. El plugin opcional DCP proporciona poda de contexto adicional para sesiones largas.

**Features de calidad (desde 0.4.0):** enforcement de execution gates, review binario del critic, workflow de brainstorm con design docs, ledgers de continuidad cross-session y circuit breaker para detección de loops.

## Agentes

| Agente | Rol | Modelo (preset default) | Tipo |
|---|---|---|---|
| **foreman** | Orquestador y scheduler maestro | streamlake/kat-coder-pro-v2.5 | primary |
| **craftsman** | Implementador artesano — bugs, features y refactors acotados (ad-hoc o planificados) | opencode-go/gpt-5.6-luna | primary |
| **warden** | Custodio de operaciones — CI/CD, deploy, releases, monitoreo | opencode-go/gpt-5.6-luna | primary |
| **ranger** | Analista / cartógrafo / onboarding — sensa y persiste hallazgos en `analyses`, no crea planes | minimax/MiniMax-M3 | primary |
| **scout** | Reconocimiento de codebase | opencode/mimo-v2.5-free | subagent |
| **scribe** | Recuperación de conocimiento externo | opencode/mimo-v2.5-free | subagent |
| **painter** | Diseño UI/UX y composición visual | opencode-go/qwen3.7-plus | subagent |
| **smith** | Implementación genérica rápida | opencode-go/mimo-v2.6-flash | subagent |
| **go-smith** | Especialista en Go | opencode-go/mimo-v2.6-flash | subagent |
| **js-smith** | Especialista en JS/TS | opencode-go/mimo-v2.6-flash | subagent |
| **python-smith** | Especialista en Python | opencode-go/mimo-v2.6-flash | subagent |
| **vue-smith** | Especialista en Vue 3 / Pinia | opencode-go/mimo-v2.6-flash | subagent |
| **zig-smith** | Especialista en Zig 0.16 | opencode-go/mimo-v2.6-flash | subagent |
| **rust-smith** | Especialista en Rust | opencode-go/mimo-v2.6-flash | subagent |
| **sage** | Asesor de arquitectura y debugging | opencode-go/kimi-k2.7-code | subagent |
| **guild** | Consenso multi-LLM y debate | minimax/MiniMax-M3 | subagent |
| **inspector** | Auditor de calidad y seguridad | opencode-go/kimi-k2.7-code | subagent |
| **critic** | Revisor binario de diffs — APPROVED/REJECTED | minimax/MiniMax-M3 | subagent |
| **chronicler** | Redactor de documentación técnica | opencode-go/deepseek-v4-flash | subagent |
| **ci-smith** | Especialista en pipelines CI/CD | opencode-go/mimo-v2.6-flash | subagent |
| **deploy-smith** | Especialista en automatización de deploys | opencode-go/mimo-v2.6-flash | subagent |
| **release-smith** | Especialista en gestión de releases | opencode-go/mimo-v2.6-flash | subagent |
| **ops-scout** | Especialista en reconocimiento de infra (solo lectura) | opencode-go/deepseek-v4-flash | subagent |

**Grupos:** Primarios (foreman, craftsman, warden, ranger), Exploradores (scout, scribe), Constructores (painter, smith, go-smith, js-smith, python-smith, vue-smith, zig-smith, rust-smith), Asesores (sage, guild), Calidad (inspector, critic, chronicler), Operaciones (ci-smith, deploy-smith, release-smith, ops-scout).

## Inicio Rápido

```bash
# Instalación rápida (interactivo)
bunx ndomo install

# No interactivo con preset
bunx ndomo install --preset=budget

# Con DCP
bunx ndomo install --with-dcp
```

Por defecto la instalación aplica `presets.default` de `config/ndomo.config.json`. Usa `--preset=budget` para modelos más económicos, `--provider=ID` para sobrescribir el prefijo de provider. Ver [docs/installer.md](docs/installer.md) para la referencia completa de flags.

O desde el código fuente:

```bash
git clone https://github.com/nicosup98/ndomo-v2 ndomo
cd ndomo
bun install
bun run src/cli/install.ts
```

Dentro de OpenCode, verifica que todos los agentes respondan:

```
ping all agents
```

## Instalación

**Requisitos:** [bun](https://bun.sh) >= 1.1.0, OpenCode instalado y configurado con al menos un proveedor autenticado.

Instalación vía bunx (recomendada):

```bash
# Instalación interactiva
bunx ndomo install

# Con provider preestablecido (no interactivo)
bunx ndomo install --provider=opencode --no-provider-prompt

# Con preset budget + DCP
bunx ndomo install --preset=budget --with-dcp
```

O desde un clon local:

```bash
git clone https://github.com/nicosup98/ndomo-v2 ndomo
cd ndomo
bun install
bun run src/cli/install.ts                        # con preset default
bun run src/cli/install.ts --preset=budget        # con modelos budget
bun run src/cli/install.ts --with-dcp             # incluye plugin DCP
```

Ver [docs/installer.md](docs/installer.md) para pasos detallados y referencia completa de flags.

> **Nota de migración:** `scripts/install.sh` se mantiene en el tarball publicado como **shim de compatibilidad para usuarios que vienen de `curl -fsSL ... | bash`** (el camino de instalación pre-0.2.0). Está deprecado — las instalaciones nuevas deben usar `bunx ndomo install`. El shim no se elimina para no romper one-liners legacy, pero no se agregarán nuevas features ahí.

**Flags:**

| Flag | Descripción |
|---|---|
| `--provider=ID` | Sobrescribe el prefijo de provider para todos los agentes. El model ID se toma del preset activo; solo se intercambia el segmento `provider/` del campo `model:`. |
| `--no-provider-prompt` | Omite el prompt interactivo de provider. El preset se aplica igualmente; no se realiza ninguna sobrescritura de prefijo de provider. |
| `--preset=NAME` | Selecciona un preset de `config/ndomo.config.json::presets[NAME]`. (default: `default`, opciones: `default`, `budget`) |
| `--with-dcp` | Instala y configura el plugin DCP. |
| `--dry-run` | Imprime los cambios planeados sin escribir archivos. |
| `--skip-deps` | Omite el paso de dependencias (`bun install`). |

**Desinstalación:** `bunx ndomo install --uninstall` o `./scripts/uninstall.sh [--keep-data]`

## Base de Datos de Planes y Tareas

ndomo persiste planes, tareas, sesiones, análisis y registros de ops (incidentes, deployments, releases, rollbacks) en una base de datos SQLite local al proyecto
(`<project>/.ndomo/state.db`) con búsqueda FTS5, trazabilidad de auditoría y
archivado automático a markdown al completarse. 62 herramientas expuestas vía OpenCode, agrupadas por dominio:

| Dominio | Herramientas |
|---|---|
| Planes | `plan_create`, `plan_get`, `plan_list`, `plan_search`, `plan_approve`, `plan_delete`, `plan_update_status`, `plan_progress`, `plan_files_write` |
| Tareas | `task_create_batch`, `task_list`, `task_update_status`, `task_verify`, `task_search`, `task_next_for_agent`, `task_peek_for_agent`, `task_dependency_resolver`, `task_add_artifact`, `task_review`, `task_escalate` |
| Sesiones y ledgers | `session_start`, `session_checkpoint`, `session_end`, `ledger_create`, `ledger_get`, `ledger_update` |
| Routing y clasificación | `route`, `can_parallel`, `classify_intent`, `classify_tests`, `code_traffic_light`, `validate_task_dependencies` |
| Dispatch y background | `dispatch`, `active_tasks`, `background_task_status`, `background_task_cancel` |
| Worktrees | `worktree_create`, `worktree_list`, `worktree_remove`, `worktree_verify` |
| Memoria | `mem_add`, `mem_search`, `mem_list`, `mem_forget`, `mem_stats`, `memory_compress` |
| Análisis | `analysis_create`, `analysis_get`, `analysis_list`, `analysis_search`, `analysis_update`, `analysis_archive`, `analysis_link_plan` |
| Obsidian | `obsidian_export`, `obsidian_read_note` |
| Ops | `incident_create`, `rollback_record` |
| Diseño y review | `design_create`, `critic_review` |
| Utilidades | `status`, `ndomo_write_unlock`, `stats` |

El foreman las usa para rastrear trabajo a través de despachos de agentes; ranger escribe filas en `analyses` (enlazables a planes vía `analysis_link_plan`). Ver
[docs/database.md](docs/database.md) para esquema, herramientas, ciclo de vida y
comportamiento de archivado automático.

CLI write surface (desde 0.3.0):
- `ndomo plan create|list|show|update|approve|complete|delete`
- `ndomo task create|list|show|update|reassign|complete|fail`

CLI report surface:
- `ndomo stats [--since 7d|30d|all] [--agent <name>] [--json]` — Scorecard por agente (tasa de éxito, duraciones, escalaciones)

## Features de Calidad (desde 0.4.0)

### Execution Gates (T1)

Las tareas pueden requerir verificación antes de completarse. Cuando `verification_required=true`, la tarea entra en estado `verifying` y se bloquea hasta que un inspector llame a `task_verify` con `verdict='passed'`. Existe un bypass auditado force+forceReason para emergencias.

```typescript
// Task creation with verification
task_create_batch({ tasks: [{ verificationRequired: true, ... }] })

// Inspector verification
task_verify({ taskId, verdict: 'passed', reason: 'tests + lint clean' })

// Force bypass (audited)
task_verify({ taskId, verdict: 'waived', force: true, forceReason: 'hotfix deploy' })
```

### Critic Agent (T2)

Agente revisor binario dedicado. Produce veredictos estructurados `APPROVED`/`REJECTED` con feedback, scores y action items. Se enruta vía inspector para el enforcement del execution gate.

```typescript
// Critic review tool
critic_review({ diff, verdict: 'APPROVED', critical: [], optimizations: [], scores: { security: 9, performance: 8, idiomaticity: 9 } })
```

### Brainstorm Workflow (T3)

Fase 0 (obligatoria antes de `plan_create`): el foreman clarifica el problema, corre `grill-me`, opcionalmente despacha scout/sage/scribe y persiste un design doc vía `design_create`.

Los design docs viven en `.ndomo/designs/YYYY-MM-DD-{slug}-design.md` e incluyen:
- Definición del problema
- Opciones evaluadas
- Decisión tomada + rationale
- Trade-offs aceptados
- Scope y exclusiones

```typescript
design_create({ slug: 'feat-x', title: 'Feature X design', problem: '...', goals: [...], constraints: [...], options: [...], decision: '...', tradeoffs: '...' })
```

### Continuity Ledger (T4)

Persistencia de contexto cross-session. Los ledgers se escriben en `.ndomo/ledgers/{sessionId}.md` en cada `session_checkpoint`. La DB sigue siendo la fuente de verdad; las escrituras de ledger son best-effort.

```typescript
// Tools
ledger_create({ sessionId, content: '...' })
ledger_get({ sessionId })
ledger_update({ sessionId, patch: { keyDecisions: [...] } })

// Auto-written on session_checkpoint (best-effort, non-blocking)
```

### Circuit Breaker (T5)

Detecta sesiones trabadas contando llamadas a herramientas. Umbrales:
- **Llamadas totales:** 4000 por sesión (configurable vía `circuitBreaker.threshold`)
- **Idénticas consecutivas:** 20 llamadas con misma tool + args

Al dispararse: se emite un warning, la tarea objetivo se marca `failed` con error `"Circuit breaker: potential loop detected"`. Las llamadas a `task_update_status` están exentas para permitir la recuperación.

```json
// config/ndomo.config.json
{
  "circuitBreaker": { "threshold": 4000 }
}
```

## Configuración

Archivo de configuración: `~/.config/opencode/ndomo.json`

```json
{
  "preset": "default",
  "caveman": { "intensity": "full", "autoClarity": true },
  "mem": {
    "storagePath": "~/.ndomo/mem",
    "defaultScope": "project",
    "autoCaptureEnabled": true,
    "cavemanCompress": true
  },
  "circuitBreaker": { "threshold": 4000 }
}
```

Ver [docs/configuration.md](docs/configuration.md) para referencia completa. Los presets de agente soportan el campo opcional `reasoning_effort` (`low`/`medium`/`high`/`xhigh`) para modelos con capacidad de razonamiento.

**Config del circuit breaker:** `circuitBreaker.threshold` (default: 4000) define el máximo de llamadas a herramientas por sesión antes de que el breaker se dispare.

## Skills

ndomo incluye 25 skills en `skills/`, agrupadas por familia:

**Protocolo caveman**
- `caveman` — modo de comunicación ultracomprimido (~75% reducción de tokens)
- `cavecrew` — delegación a subagentes estilo caveman (investigator, builder, reviewer)
- `caveman-review` — comentarios de code review ultracomprimidos (ubicación, problema, fix)

**Workflow y calidad**
- `grill-me` — entrevista implacable para afilar un plan o diseño
- `find-skills` — descubrir e instalar skills adicionales
- `frontend-design` — guía de diseño visual distintivo, sin plantillas
- `security-review` — checklist de seguridad para auth, input, secretos, pagos
- `api-security-best-practices` — patrones seguros de API (authN/Z, validación, rate limiting)

**Bash**
- `bash-scripting` — scripts de shell listos para producción con patrones defensivos

**Bun / JS / TS**
- `bun` — build, run, test y bundle de JS/TS con Bun
- `modern-javascript-patterns` — idioms ES6+ y patrones funcionales
- `javascript-testing-patterns` — estrategias con Jest, Vitest y Testing Library

**Vue**
- `vue-best-practices` — Composition API, `<script setup>` y TypeScript
- `vue-pinia-best-practices` — stores Pinia y patrones de reactividad

**Go**
- `golang-patterns` — patrones y convenciones idiomáticas de Go
- `golang-security` — seguridad en inyección, cripto, filesystem y red
- `golang-testing` — tests table-driven, subtests, benchmarks, fuzzing

**Python**
- `python-anti-patterns` — checklist de anti-patrones comunes a evitar
- `python-design-patterns` — KISS, separación de responsabilidades, composición sobre herencia
- `python-error-handling` — validación, jerarquías de excepciones, fallos parciales
- `python-testing-patterns` — fixtures de pytest, mocking, TDD

**Rust**
- `rust-patterns` — ownership, manejo de errores, traits, concurrencia
- `rust-testing` — tests unitarios, de integración, async, property-based, cobertura

**Zig**
- `zig-0.16` — guía de API y notas de porteo para Zig 0.16.0

## Integraciones

- **Memoria embedded** (integrada) — memoria persistente con bun:sqlite + FlexSearch. Una DB SQLite por proyecto en `~/.ndomo/mem/projects/<projectTag>.db` (WAL). Tools: `mem_add`, `mem_search`, `mem_list`, `mem_forget`, `mem_stats`, y `memory_compress` (compresión caveman vía regex, 0 tokens de LLM). Los shards de memoria legacy pueden migrarse con `bun scripts/migrate-memory.ts`.
- **DCP** (opcional) — `@tarquinen/opencode-dcp` para poda dinámica de contexto. Licencia AGPL-3.0. Se instala con flag `--with-dcp`.
- **Capa Obsidian** (integrada) — proyección determinista y unidireccional (repo → vault) de planes, tareas, designs y memorias hacia un vault Obsidian externo. Tools: `obsidian_export` (idempotente, skip por SHA-256) y `obsidian_read_note`. Requiere el bloque `obsidian` en `ndomo.json`; sin reverse sync, watchers ni CLI. Ver [docs/obsidian.md](docs/obsidian.md).

Ver [docs/integrations.md](docs/integrations.md) para detalles.

## Ahorro de Tokens

El protocolo de salida Caveman reduce el uso de tokens ~60-75% vs prosa estándar eliminando artículos, palabras de relleno, conjunciones y cortesías, preservando todo el contenido técnico. El plugin DCP añade poda adicional eliminando salidas de herramientas de bajo valor del historial de conversación.

## Licencia

MIT

## Enlaces

- Repositorio: [https://github.com/nicosup98/ndomo-v2](https://github.com/nicosup98/ndomo-v2)
- OpenCode: [https://github.com/opencode-ai](https://github.com/opencode-ai)

# ndomo

Plugin multi-agente para OpenCode. Taller de artesanos: 19 especialistas bajo un Foreman, un Craftsman y un Warden. Nativo en caveman. opencode-mem integrado. DCP peer opcional.

## Qué es ndomo

ndomo es un plugin de orquestación multi-agente para [OpenCode](https://github.com/opencode-ai). Enruta tareas de desarrollo a 19 agentes especializados (scout, scribe, painter, smith, sage, guild, stack-smiths, inspector, chronicler, y ops agents) coordinados por 3 primaries: Foreman (planificación), Craftsman (implementación), Warden (operaciones). Todos los agentes usan el protocolo de salida Caveman para comunicación eficiente en tokens. La persistencia de memoria entre sesiones la gestiona opencode-mem. El plugin opcional DCP proporciona poda de contexto adicional para sesiones largas.

## Agentes

| Agente | Rol | Modelo (preset default) | Tipo |
|---|---|---|---|
| **foreman** | Orquestador y scheduler maestro | minimax/MiniMax-M3 | primary |
| **warden** | Custodio de operaciones — CI/CD, deploy, releases, monitoreo | opencode-go/deepseek-v4-flash | primary |
| **scout** | Reconocimiento de codebase | opencode-go/minimax-m2.7 | subagent |
| **scribe** | Recuperación de conocimiento externo | opencode-go/minimax-m2.7 | subagent |
| **painter** | Diseño UI/UX y composición visual | opencode-go/kimi-k2.6 | subagent |
| **smith** | Implementación genérica rápida | opencode-go/deepseek-v4-flash | subagent |
| **go-smith** | Especialista en Go | xiaomi/mimo-v2.5-pro | subagent |
| **js-smith** | Especialista en JS/TS | xiaomi/mimo-v2.5-pro | subagent |
| **python-smith** | Especialista en Python | xiaomi/mimo-v2.5-pro | subagent |
| **vue-smith** | Especialista en Vue 3 / Pinia | xiaomi/mimo-v2.5-pro | subagent |
| **zig-smith** | Especialista en Zig 0.16 | xiaomi/mimo-v2.5-pro | subagent |
| **rust-smith** | Especialista en Rust | opencode-go/mimo-v2.5-pro | subagent |
| **sage** | Asesor de arquitectura y debugging | opencode-go/deepseek-v4-pro | subagent |
| **guild** | Consenso multi-LLM y debate | opencode-go/deepseek-v4-pro | subagent |
| **inspector** | Auditor de calidad y seguridad | opencode-go/deepseek-v4-pro | subagent |
| **chronicler** | Redactor de documentación técnica | opencode-go/deepseek-v4-flash | subagent |
| **ci-smith** | Especialista en pipelines CI/CD | opencode-go/deepseek-v4-flash | subagent |
| **deploy-smith** | Especialista en automatización de deploys | opencode-go/deepseek-v4-flash | subagent |
| **release-smith** | Especialista en gestión de releases | opencode-go/deepseek-v4-flash | subagent |
| **ops-scout** | Especialista en reconocimiento de infra (solo lectura) | opencode-go/deepseek-v4-flash | subagent |

**Grupos:** Orquestador (foreman), Exploradores (scout, scribe), Constructores (painter, smith, go-smith, js-smith, python-smith, vue-smith, zig-smith, rust-smith), Asesores (sage, guild), Calidad (inspector, chronicler), Operaciones (warden, ci-smith, deploy-smith, release-smith, ops-scout).

## Inicio Rápido

```bash
# Instalación rápida (interactivo, preguntará por HTTP)
bunx ndomo install

# No interactivo con preset + HTTP habilitado
bunx ndomo install --preset=budget --enable-http

# Con DCP
bunx ndomo install --with-dcp
```

Por defecto la instalación aplica `presets.default` de `config/ndomo.config.json`. Usa `--preset=budget` para modelos más económicos, `--provider=ID` para sobrescribir el prefijo de provider, `--enable-http` para activar el servidor HTTP.

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
# Instalación interactiva (preguntará por HTTP)
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

Ver [docs/installer.md](docs/installer.md) para pasos detallados.

**Flags:**

| Flag | Descripción |
|---|---|
| `--provider=ID` | Sobrescribe el prefijo de provider para todos los agentes. El model ID se toma del preset activo; solo se intercambia el segmento `provider/` del campo `model:`. Ejemplo: el preset da `opencode-go/minimax-m2.7`, `--provider=opencode` reescribe a `opencode/minimax-m2.7`. |
| `--no-provider-prompt` | Omite el prompt interactivo de provider. El preset se aplica igualmente; no se realiza ninguna sobrescritura de prefijo de provider. |
| `--preset=NAME` | Selecciona un preset de `config/ndomo.config.json::presets[NAME]`. El preset es la fuente de verdad para los modelos de agentes al instalar. (default: `default`, opciones: `default`, `budget`) |
| `--with-dcp` | Instala y configura el plugin DCP. |
| `--dry-run` | Imprime los cambios planeados sin escribir archivos. |
| `--skip-deps` | Omite el paso de dependencias (`bun install`). |
| `--enable-http` | Activa automáticamente el servidor HTTP (escribe bloque http en `ndomo.config.json`). |
| `--disable-http` | Omite por completo el prompt automático de HTTP (default en no-TTY / CI). |
| `--port=N` | Puerto del servidor HTTP (default: `4097`). |
| `--cors-origins=CSV` | Orígenes CORS del HTTP, separados por comas (default: `*`). |
| `--auth-required=BOOL` | Requisito de auth HTTP (default: `true`). |

**Desinstalación:** `bunx ndomo install --uninstall` or `./scripts/uninstall.sh [--keep-data]`

## Base de Datos de Planes y Tareas

ndomo persiste planes, tareas y sesiones en una base de datos SQLite local al proyecto
(`<project>/.ndomo/state.db`) con búsqueda FTS5, trazabilidad de auditoría y
archivado automático a markdown al completarse. 14 herramientas expuestas vía OpenCode:
`plan_create`, `plan_get`, `plan_list`, `plan_search`, `plan_approve`,
`plan_update_status`, `task_create_batch`, `task_list`, `task_update_status`,
`task_search`, `task_next_for_agent`, `session_start`, `session_checkpoint`,
`session_end`.

El foreman las usa para rastrear trabajo a través de despachos de agentes. Ver
[docs/database.md](docs/database.md) para esquema, herramientas, ciclo de vida y
comportamiento de archivado automático.

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
  }
}
```

Ver [docs/configuration.md](docs/configuration.md) para referencia completa. Los presets de agente soportan el campo opcional `reasoning_effort` (`low`/`medium`/`high`/`xhigh`) para modelos con capacidad de razonamiento.

## Skills

ndomo incluye 7 skills en `skills/`:

| Skill | Descripción |
|---|---|
| `caveman` | Modo de comunicación ultracomprimido (~75% reducción de tokens) |
| `cavecrew` | Subagentes estilo caveman (investigator, builder, reviewer) |
| `deepwork` | Flujo estructurado para trabajo pesado con plan files y review gates |
| `reflect` | Análisis de fricción en el flujo de trabajo y extracción de patrones |
| `worktrees` | Gestión de git worktrees para carriles aislados de desarrollo |
| `dcp-integration` | Guía de integración de Dynamic Context Pruning |
| `mem-recall` | Uso de herramientas opencode-mem y patrones de recuperación |

## Integraciones

- **opencode-mem** (requerido) — memoria persistente con SQLite + USearch vector DB. Interfaz web en `:4747`. Todos los agentes comprimen recuerdos antes de almacenar usando compresión caveman vía regex (0 tokens de LLM).
- **DCP** (opcional) — `@tarquinen/opencode-dcp` para poda dinámica de contexto. Licencia AGPL-3.0. Se instala con flag `--with-dcp`.

Ver [docs/integrations.md](docs/integrations.md) para detalles.

## Ahorro de Tokens

El protocolo de salida Caveman reduce el uso de tokens ~60-75% vs prosa estándar eliminando artículos, palabras de relleno, conjunciones y cortesías, preservando todo el contenido técnico. El plugin DCP añade poda adicional eliminando salidas de herramientas de bajo valor del historial de conversación.

## Licencia

MIT

## Enlaces

- Repositorio: `<repo-url>`
- OpenCode: [https://github.com/opencode-ai](https://github.com/opencode-ai)
- opencode-mem: [https://github.com/opencode-ai/opencode-mem](https://github.com/opencode-ai/opencode-mem)

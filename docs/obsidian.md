# Obsidian Brain Layer

Guía de la capa de proyección de ndomo hacia un vault Obsidian externo.

- **Design doc:** [.ndomo/designs/2026-09-25-obsidian-brain-layer-design.md](../.ndomo/designs/2026-09-25-obsidian-brain-layer-design.md)
- **Config:** [docs/configuration.md](configuration.md#obsidian-brain-layer)
- **Módulo:** `src/obsidian/` (paths, render, kind, sync-state, design-source, fs — DB-free)

## Propósito

Proyección **determinista** del estado operativo ndomo a un vault Obsidian:

- **SQLite (`<project>/.ndomo/state.db`) + memoria embebida (`~/.ndomo/mem/`) = únicas fuentes de verdad transaccionales.** El vault nunca es fuente de verdad: no se lee para decidir nada, sólo se escribe.
- **Obsidian = interfaz humana unidireccional** (repo → vault): revisión narrativa, enlaces wiki y análisis de grafo.
- **Disparo explícito:** las tools `obsidian_export` / `obsidian_read_note` se invocan a demanda desde agentes. **Sin CLI, sin watchers, sin hooks, sin cron, sin procesos de fondo.**
- **Idempotente:** re-exportar lo unchanged es un no-op (`status: "skipped"`), el hash SHA-256 decide.
- **No rompe sesiones:** los errores vuelven siempre como envelope `{ok:false,error:{code,message,hint}}`, nunca como excepción no capturada.

## Configuración

Bloque `obsidian` en `~/.config/opencode/ndomo.json`:

```json
{
  "obsidian": {
    "enabled": true,
    "vaultPath": "~/Vaults/ndomo-brain",
    "allowInsideRepo": false
  }
}
```

| Campo | Tipo | Default | Descripción |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. `false` → `DISABLED`, no se toca el vault. |
| `vaultPath` | string | `""` | Raíz del vault (`~` expandido). **Obligatorio en la práctica**: vacío → `NOT_CONFIGURED`. Debe quedar fuera del repo salvo `allowInsideRepo: true`. |
| `allowInsideRepo` | boolean | `false` | Habilita un vault **dentro** del repo. Guard config-only: no existe bypass por argumento en cada llamada. |

### Precedencia de `vaultPath`

Resuelto por campo (`loadObsidianConfig`, `src/config/schema.ts`):

1. `obsidian.vaultPath` del `ndomo.json` (si no está vacío).
2. `NDOMO_OBSIDIAN_VAULT_PATH` (env) — pensado para tests/CI, apunta a un tmp dir sin escribir config.
3. Default `""` → `NOT_CONFIGURED`.

`enabled` y `allowInsideRepo` sólo se leen del archivo. Un bloque parcial o ausente es siempre válido: cada campo cae a su default.

### Guards

- `vaultPath` dentro del repo + `allowInsideRepo: false` → `INSIDE_REPO`. El chequeo combina un test léxico (`path.relative`) con un `realpath` best-effort: un symlink hacia el repo también cae.
- El directorio del vault **se crea si falta** (mkdir recursivo) antes de la primera escritura.
- Todo segmento dinámico de path pasa por `sanitizeSegment` (kebab-case ASCII): `..`, `/`, `\` colapsan a `-`, así que ninguna entidad puede escapar de `Projects/<tag>/…`. Una ruta pedida a `obsidian_read_note` que intente salir del vault → `UNSAFE_PATH`.

## Tools

Ambas devuelven siempre un envelope. Éxito:

```json
{ "ok": true, "data": { "...": "..." } }
```

Error:

```json
{ "ok": false, "error": { "code": "NOT_CONFIGURED", "message": "…", "hint": "…" } }
```

`hint` es opcional (puede no venir).

### `obsidian_export`

```ts
obsidian_export({
  entityType: "plan" | "task" | "design" | "memory",
  entityId: string,
  scope?: "single" | "plan",   // default "single"
  kind?: ObsidianKind,         // override validado (vocabulario cerrado)
})
```

| Arg | Tipo | Default | Descripción |
|---|---|---|---|
| `entityType` | `plan\|task\|design\|memory` | — | Familia de entidad a proyectar. |
| `entityId` | string | — | Id de la entidad en la DB (para `design`: slug o filename del documento en `.ndomo/designs/`). |
| `scope` | `single\|plan` | `single` | `scope: "plan"` (con `entityType: "plan"`) exporta el plan **y** sus tasks no archivadas. |
| `kind` | `ObsidianKind` | — | Override explícito de clasificación. Validado contra el vocabulario cerrado; fuera de él → `INVALID_KIND`. |

Resultado (`data`):

```json
{
  "items": [
    { "entityType": "task", "entityId": "tsk_01H…", "status": "exported", "path": "Projects/ndomo-project-abc/30-Bugfixes/my-plan__t00-tsk-01h.md", "kind": "bugfix" }
  ],
  "warning": null
}
```

| Campo | Descripción |
|---|---|
| `items[].status` | `"exported"` = escribió/re-escribió la nota; `"skipped"` = hash idéntico, no-op (sólo avanza `lastCheckedAt`). |
| `items[].path` | Ruta **relativa al vault** (siempre `/`). |
| `items[].kind` | Kind efectivo usado para elegir carpeta. |
| `data.warning` | `string \| null` — p. ej. `"sync-state missing"` o `"sync-state corrupt"` (estado degradado a fresco, no es un error). |

### `obsidian_read_note`

```ts
obsidian_read_note({
  path?: string,        // ruta RELATIVA al vault
  entityType?: string,  // alternativa a path
  entityId?: string,
})
```

Lee una nota ya proyectada. Se le pasa **o** `path` (vault-relativo) **o** el par `entityType` + `entityId` (resuelto vía sync-state). Devuelve el **markdown crudo** (`string`) o `null` cuando la nota no existe / no pudo resolverse, dentro del envelope `{ok:true,data:…}`. Un `path` que intente escapar del vault (`../`, ruta absoluta) → `UNSAFE_PATH`.

## Taxonomía de carpetas

Todas las notas viven bajo el namespace del proyecto: `<vault>/Projects/<tag>/<carpeta>/`, donde `<tag>` es el `projectTag` sanitizado a kebab-case (`ndomo_project_abc` → `ndomo-project-abc`).

| Carpeta | Qué recibe |
|---|---|
| `10-Plans` | **Todas** las notas de plan (índice/roadmap), cualquier kind. |
| `20-Features` | Tasks con kind `feature`. |
| `30-Bugfixes` | Tasks con kind `bugfix`. |
| `40-Infra` | Tasks con kind `infra`. |
| `50-Designs` | Notas de design (fija) **y** tasks con kind `design`. |
| `60-Refactors` | Tasks con kind `refactor`. |
| `70-Docs` | Tasks con kind `docs`. |
| `80-Research` | Tasks con kind `research`. |
| `90-Other` | Tasks con kind `other`. |
| `95-Memories` | Memorias (**siempre**, excepción deliberada a kind→carpeta: `memory.type` es free-form sin señal JEV). |

El folder de una task sale de su **kind efectivo**: si la llamada trae `kind?`, ese override (validado) manda; si no, `metadata.obsidianKind` de la task → kind heredado del plan padre → `other`.

### Clasificación (`kind`) — precedencia

Vocabulario cerrado: `feature | bugfix | refactor | infra | design | docs | research | other`.

| Entidad | Cadena de precedencia |
|---|---|
| plan | `metadata.obsidianKind` → `metadata.jevIntent` (mapeo JEV: `bugfix/feature/refactor` iguales, `question`→`research`, `other`/`none`→`other`) → `metadata.category` → `plans.category` (`docs`/`infra` propios) → `other` |
| task | `metadata.obsidianKind` → kind del plan padre → `other` |
| memory | `metadata.obsidianKind` → `other` |

Sin red, sin LLM: sólo señales persistidas en la DB (+ el override explícito del caller).

## Nombres de archivo

| Entidad | Nombre |
|---|---|
| plan | `<plan-slug>.md` |
| task | `<plan-slug>__t<NN>-<task-id8>.md` |
| design | `<filename fuente sin .md>.md` (sólo basename, sanitizado) |
| memory | `<content-slug>__<id8>.md` (slug de hasta 6 palabras) |

- `NN` = `orderIndex` con 2 dígitos (`0` → `00`).
- `id8` = primeros 8 caracteres del id sanitizado.
- `__` + `tNN` + id8 mantiene las tasks ordenables y re-exportables aunque cambie el slug del plan.

Ejemplo completo: `~/Vaults/ndomo-brain/Projects/ndomo-project-abc/30-Bugfixes/fix-login__t02-ab12cd34.md`.

## Anatomía de una nota

```markdown
---
ndomoEntity: 'task'
ndomoId: 'tsk_01H…'
ndomoKind: 'bugfix'
ndomoProjectTag: 'ndomo_project_abc'
title: 'Arreglar redirect de login'
status: 'done'
plan: '[[Projects/ndomo-project-abc/10-Plans/fix-login|fix-login]]'
planId: 'pln_01H…'
planSlug: 'fix-login'
orderIndex: 2
createdAt: '2026-09-25T20:25:47.888Z'
completedAt: '2026-09-26T10:00:00.000Z'
---
%% ndomo:auto:start %%
# Arreglar redirect de login

> **Bugfix** — Fix for broken behavior

- **Status:** `done`
- **Plan:** [[Projects/ndomo-project-abc/10-Plans/fix-login|fix-login]]

## Result

…generado desde la DB…
%% ndomo:auto:end %%

## Notas humanas

…escrito por el humano en Obsidian, preservado verbatim…
```

### Frontmatter gestionado

Regenerado en **cada** export, con orden de claves estable. Claves comunes: `ndomoEntity`, `ndomoId`, `ndomoKind`, `ndomoProjectTag`, `title`, `status`. Además:

| Entidad | Claves extra |
|---|---|
| plan | `slug`, `priority`, `complexity`, `createdAt`, `updatedAt`, `approvedAt`, `completedAt` |
| task | `plan` (link wiki), `planId`, `planSlug`, `orderIndex`, `complexity`, `createdAt`, `completedAt` |
| design | `slug`, **`sourcePath`** (`.ndomo/designs/<filename>` — el artefacto original sigue en el repo), `date` |
| memory | `type`, `tags`, `source`, `createdAt`, `updatedAt` |

Fechas en **ISO-8601** (`new Date(ts).toISOString()`), valores ausentes → la clave se omite. Escalado de comillas simple (`'` → `''`) y saltos de línea colapsados a espacio: el YAML siempre parsea.

Los links wiki del cuerpo tienen la forma `[[Projects/<tag>/<folder>/<file>|Título]]` (sin `.md`); el plan lista sus tasks como `- [[…|Título]] — \`status\``.

### Marcadores y sección humana

- La frontmatter queda **fuera** de los marcadores; el bloque generado va entre `%% ndomo:auto:start %%` y `%% ndomo:auto:end %%`.
- **Todo lo que sigue a `%% ndomo:auto:end %%` pertenece al humano** y se preserva **verbatim** en cada re-export (`mergeNote`). Sección por defecto en una nota nueva: `## Notas humanas`.
- Texto generado que citara un marker se "desactiva" al look-alike con guiones (`%% ndomo:auto-start %%`), así el marker real aparece exactamente una vez, en la frontera.
- Un archivo existente **sin** markers (ajeno o editado a mano) se trata como no-proyectado: gana el contenido generado.

### Idempotencia (SHA-256)

El hash se calcula sobre el **autoPayload** = frontmatter gestionado + bloque auto. **Excluye la sección humana**, por diseño:

- Un cambio en la DB → hash distinto → reescritura (`exported`).
- Sólo ediciones humanas → hash igual → `skipped` (no se reescribe; avanza `lastCheckedAt`).
- Contrato: el hash garantiza que el **payload gestionado** esté sincronizado, no el archivo completo.

### sync-state y estabilidad de path

- Ubicación: `~/.ndomo/obsidian/projects/<tag>/sync-state.json` — **fuera del vault**, es bookkeeping propio de ndomo (contenido del vault no editable por el humano).
- Key: `<entityType>:<entityId>`; entry: `{ path, kind, hash, createdAt, updatedAt, lastCheckedAt }`, `version: 1`.
- `path` se asigna **una vez** y queda registrado: renombrar el slug del plan después **no mueve** el archivo (evita churn); el frontmatter refleja el slug actual.
- **Carga tolerante**: archivo missing o corrupto → estado fresco + `warning` en el resultado (nunca throw). Escritura atómica (temp + rename). Perder el sync-state sólo implica re-proyectar todo.

### Migración al cambiar de kind

Si un re-export resuelve un kind distinto y la carpeta destino difiere:

1. Se calcula el nuevo path.
2. La **sección humana** se arrastra desde el archivo viejo al nuevo.
3. El archivo viejo se **borra**.

Resultado: una sola nota por entidad, sin duplicados ni notas huérfanas por cambio de clasificación.

## Diagramas D2

Los designs pueden llevar diagramas D2 que viajan verbatim hasta la nota en `50-Designs` y renderizan en Obsidian vía el plugin d2-obsidian. Flujo verificado e2e el 2026-09-29 con el design `2026-09-29-d2-diagrams-adoption-design.md`.

### Flujo

1. `design_create` acepta `diagrams: { title?, code }[]` (`src/plugin.ts:2429`; tipo en `src/db/designs.ts:63-64`) y serializa una sección `## Diagrams` en el md fuente (`.ndomo/designs/<filename>`), insertada entre `## Consequences` y `## Open Questions` (`src/db/designs.ts:312-318`).
2. Cada diagrama con `code` no vacío se emite como fence ```d2 (con `### <title>` si lo trae); el fence nunca baja de 3 backticks y sube a 4+ si el código contiene ``` (`src/db/designs.ts:221-231`).
3. `obsidian_export` lee el archivo fuente completo (`src/obsidian/design-source.ts:79,110-113`) y lo incrusta en el managed block de la nota (`src/obsidian/export.ts:377-388`, `render.ts:463-478`): los fences viajan **verbatim** al auto block.
4. El plugin d2-obsidian renderiza el fence desde el código del bloque — **sin** archivos `.d2` referenciados ni imports dentro (`skills/d2-diagrams/SKILL.md:53-56`).

### Validación best-effort (pre-write)

`createDesign` valida con la CLI `d2` **antes** de escribir el md (`src/db/designs.ts:459`); un diagrama inválido nunca deja un archivo a medias:

| Escenario | Comportamiento |
|---|---|
| `d2` en PATH + diagrama inválido | Error (`d2 validate` exit ≠ 0 → throw, `src/db/designs.ts:414-423`); **no** se escribe el md |
| `d2` ausente (ENOENT) | Skip silencioso, sin error (`src/db/designs.ts:405-408`) |
| Sin diagramas / codes en blanco | No-op (`src/db/designs.ts:209-214`) |

### E2E verificado (2026-09-29)

- Design `2026-09-29-d2-diagrams-adoption-design.md` exportado → nota `50-Designs/2026-09-29-d2-diagrams-adoption-design.md` con **3 fences** ```d2 dentro del auto block.
- Re-export → `status: "skipped"`: los fences son estables y la idempotencia SHA-256 del auto block sigue intacta (ver [Idempotencia (SHA-256)](#idempotencia-sha-256)).

### Fuentes canónicas y CI

- Fuentes versionadas: `docs/diagrams/*.d2` (kebab-case); convención de autoría en `skills/d2-diagrams/SKILL.md`.
- Render local on-demand: `bun run diagrams:render` (`package.json:49` → `scripts/render-diagrams.sh`) — SVGs hermanos **gitignored** (no se commitean; `scripts/render-diagrams.sh:4-6`).
- CI: `.github/workflows/d2.yml` corre `d2 validate` + `d2 fmt --check` sobre todos los `*.d2` del repo, con d2 pinneado a v0.9.0 (`d2.yml:27,59-77`).

### Limitaciones

- **GitHub no renderiza ```d2** (solo mermaid): el render visual vive en Obsidian; en el repo se lee la fuente `.d2` o se corre `bun run diagrams:render`.
- El plugin d2-obsidian solo renderiza **fenced code blocks** ```d2 — no archivos `.d2` ni imports dentro del bloque (`skills/d2-diagrams/SKILL.md:68-71`).

## Códigos de error

| Code | Causa | Hint típico |
|---|---|---|
| `NOT_CONFIGURED` | `vaultPath` vacío (sin config ni env). | Definir `obsidian.vaultPath` o `NDOMO_OBSIDIAN_VAULT_PATH`. |
| `DISABLED` | `obsidian.enabled: false`. | Activar `obsidian.enabled` en `ndomo.json`. |
| `INSIDE_REPO` | `vaultPath` dentro del repo con `allowInsideRepo: false`. | Usar un vault externo (`~/Vaults/ndomo-brain`) o, sólo si se acepta el riesgo, `allowInsideRepo: true`. |
| `ENTITY_NOT_FOUND` | `entityId` no existe en la DB para ese `entityType`. | Verificar el id (`plan_get`, `task_list`, `mem_search`, `design_*`). |
| `SOURCE_NOT_FOUND` | Design no encontrado en `<project>/.ndomo/designs/`. | Pasar filename o slug válido; crear el design antes con `design_create`. |
| `UNSAFE_PATH` | Path relativo, `..`/traversal o intento de salir del vault. | En `obsidian_read_note` usar una ruta **vault-relativa** sin `..`. |
| `INVALID_KIND` | `kind?` fuera del vocabulario cerrado. | Usar uno de `feature\|bugfix\|refactor\|infra\|design\|docs\|research\|other`. |
| `VAULT_UNWRITABLE` | Sin permisos / no se pudo crear el dir del vault. | Revisar permisos de `vaultPath` y del directorio padre. |
| `IO_ERROR` | Fallo de lectura/escritura con causa subyacente. | Revisar disco/permisos; el mensaje conserva la causa (`EACCES`, `ENOSPC`…). |

## Ejemplos de invocación

| Qué | Llamada |
|---|---|
| Exportar un plan | `obsidian_export({ entityType: "plan", entityId: "pln_01H…" })` |
| Plan + sus tasks | `obsidian_export({ entityType: "plan", entityId: "pln_01H…", scope: "plan" })` |
| Una task | `obsidian_export({ entityType: "task", entityId: "tsk_01H…" })` |
| Task con kind override | `obsidian_export({ entityType: "task", entityId: "tsk_01H…", kind: "bugfix" })` |
| Design (slug) | `obsidian_export({ entityType: "design", entityId: "obsidian-brain-layer" })` |
| Memoria | `obsidian_export({ entityType: "memory", entityId: "mem_01H…" })` |
| Leer por path | `obsidian_read_note({ path: "Projects/ndomo-project-abc/10-Plans/fix-login.md" })` |
| Leer por entidad | `obsidian_read_note({ entityType: "task", entityId: "tsk_01H…" })` |

Flujo típico de un agente: `plan_approve` → `obsidian_export({entityType:"plan", scope:"plan"})` → cerrar tasks → `obsidian_export` por task o re-export del plan; ante duda de contenido, `obsidian_read_note`.

## Limitaciones (MVP)

- **Sin reverse sync:** las ediciones humanas en Obsidian **nunca** se escriben de vuelta al repo ni a la DB. La sección `## Notas humanas` vive sólo en el vault (fase 2, con validación humana explícita).
- **Sin watchers/hooks/cron:** nada se proyecta salvo que un agente llame a `obsidian_export`.
- **Sin proyección de otras entidades:** `analyses`, `incidents`, `ledgers` y `sessions` no se exportan (evaluar post-MVP).
- **Sin migración masiva:** el export es on-demand por entidad; el histórico completo no se vuelca de una.
- **Sin integraciones de Obsidian:** no hay Dataview, Canvas ni generación de grafo; sólo Markdown + frontmatter + links wiki.
- **Notas huérfanas:** si una entidad se borra de la DB, su nota queda intacta (sin tombstone ni limpieza automática).
- **Slug renombrado no mueve archivos** (path estable por sync-state); el frontmatter sí refleja el slug nuevo.

---
name: d2-diagrams
description: >
  Autoría de diagramas D2 (d2lang) como documentación en ndomo. Use when creating,
  editing, validating, or formatting D2 diagrams: canonical sources live in
  docs/diagrams/*.d2 (kebab-case), fenced ```d2 blocks must be self-contained (no
  imports — the Obsidian d2 plugin renders from embedded code/stdin), comment with
  `#` (never `---`), escape `${}` with single quotes, check with `d2 validate`, format
  with `d2 fmt`, render on-demand with the d2 CLI (SVGs never committed). Limits:
  d2-obsidian renders code blocks only (not .d2 files); GitHub does not render d2.
---

# D2 Diagrams Skill Reference

Convención de autoría de diagramas D2 en ndomo. Da soporte al workflow D2 de chronicler (`agents/chronicler.md`) y a la adopción decidida en `.ndomo/designs/2026-09-29-d2-diagrams-as-docs-design.md` (status: decided). d2 v0.9.0 instalado localmente.

## Canonical Sources

- Fuentes `.d2` versionadas en `docs/diagrams/`, naming **kebab-case**: `plugin-architecture.d2`, `task-lifecycle.d2`, `erd.ndomo.d2`.
- El fence ```d2 embebido en un documento replica la fuente canónica; la fuente manda.
- SVGs renderizados **no se versionan** (design doc: "No commitear SVGs renderizados").

## Gold Rules (d2 v0.9.0)

- **Arrays separados por `;`:** valores múltiples en `vars`, `classes`, `style` inline y atributo `class` se separan con `;`, nunca con `,`:
  ```d2
  x: {
    class: box; rounded
    style: { fill: red; stroke: blue }
  }
  ```
- **Containers:** agrupar componentes anidando bloques; el container toma su propio shape o usa el default:
  ```d2
  backend: {
    api: EmployeeService
    db: Postgres
  }
  ```
- **ERD con `shape: sql_table`:** entidades como tablas, columnas declaradas dentro:
  ```d2
  users: {
    shape: sql_table
    id: int
    email: varchar
    plan_id: int
  }
  ```
- **`direction`:** controlar el layout a nivel de diagrama: `direction: right` (default), `down`, `left`, `up`.
- **Globs:** `*` para conexiones/estilos masivos (ej. `* -> logs: { style: { stroke-dash: 3 } }`).
- **Comentarios con `#`:** nunca `---` ni frontmatter YAML dentro de un `.d2` — `---` rompe el parseo de d2.
- **Escapar `${}`:** si el diagrama contiene `${...}`, envolverlo en comillas simples (`'${var}'`) para que no se interpole como template en el pipeline Markdown/fences.

## Fenced Blocks (Obsidian)

- Los diagramas embebidos como fence ```d2 deben ser **self-contained**: sin `import` ni `@` a otros archivos.
- El plugin d2-obsidian renderiza desde el código del bloque (stdin); no resuelve imports dentro del bloque (issues #45/#42).
- Debajo del fence incluir la referencia a la fuente: `Fuente: docs/diagrams/<name>.d2`.

## Commands (on-demand)

| Comando | Propósito |
|---------|-----------|
| `d2 validate <file.d2>` | Valida sintaxis. Correr antes de embeber un fence o cerrar tarea |
| `d2 fmt <file.d2>` | Formatea el archivo según estilo canónico |
| `d2 fmt --check <file.d2>` | Verifica que el archivo ya está formateado (gate CI) |
| `d2 --sketch <file.d2> out.svg` | Render on-demand a SVG local (no commitear) |

## Limits

- Plugin d2-obsidian solo renderiza **code blocks** ```d2 — NO soporta archivos `.d2` ni imports dentro de bloques.
- GitHub no renderiza ```d2 (solo mermaid): el valor visual vive en Obsidian; en el repo se lee la fuente `.d2` → render on-demand local.
- Plugin d2-obsidian congelado en 1.1.4 (dic-2023), funcional con d2 v0.9.0; monitorear.
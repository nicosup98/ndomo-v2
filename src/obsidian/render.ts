/**
 * ndomo obsidian — deterministic note renderers (plan / task / design / memory).
 *
 * Contract:
 * - **Pure + deterministic.** No `Date.now()` / bare `new Date()` inside a
 *   renderer: timestamps arrive as `number` inputs and are formatted with
 *   `new Date(ts).toISOString()` (deterministic given `ts`). The only I/O in
 *   this module is {@link resolveNoteContent} (realpath containment checks,
 *   atomic write + old-file delete).
 * - Renderers return {@link RenderedNote}:
 *   - `autoPayload` = managed YAML frontmatter + the
 *     `%% ndomo:auto:start %% … %% ndomo:auto:end %%` block. It NEVER carries
 *     human content and is what gets SHA-256 hashed for idempotency.
 *   - `markdown` = `autoPayload` + {@link DEFAULT_HUMAN_SECTION}.
 * - Everything after `AUTO_END` belongs to the human and is preserved verbatim
 *   across re-exports ({@link mergeNote}); the frontmatter and the auto block
 *   are always regenerated.
 * - Wiki links use the vault layout from ./paths.ts:
 *   `[[Projects/<tag>/<folder>/<file>|Title]]` (no `.md`, folder/slug
 *   segments sanitized exactly like the path builders do).
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { atomicWriteFileSync, deleteFileIfExists, readFileIfExists } from "./fs.ts";
import { FOLDER_BY_KIND, PLANS_FOLDER, PROJECTS_FOLDER, sanitizeSegment } from "./paths.ts";
import type { ObsidianKind } from "./types.ts";

// ─── Markers ────────────────────────────────────────────────────────────────

/** Opens the ndomo-managed block (frontmatter stays outside the markers). */
export const AUTO_START = "%% ndomo:auto:start %%";

/** Closes the ndomo-managed block; everything after it is human-owned. */
export const AUTO_END = "%% ndomo:auto:end %%";

/** Hyphenated look-alikes substituted when input text quotes a marker. */
const DEFUSED_START = "%% ndomo:auto-start %%";
const DEFUSED_END = "%% ndomo:auto-end %%";

/**
 * Queue appended when the note has no markers yet (or does not exist).
 * Starts with the newline that immediately follows {@link AUTO_END}, so
 * `autoPayload + DEFAULT_HUMAN_SECTION` is a well-formed markdown file.
 */
export const DEFAULT_HUMAN_SECTION = "\n## Notas humanas\n\n";

// ─── Kind overlay (labels + hints rendered on every note) ───────────────────

/** Human-readable label of each kind (template overlay). */
export const KIND_LABEL: Record<ObsidianKind, string> = {
  feature: "Feature",
  bugfix: "Bugfix",
  refactor: "Refactor",
  infra: "Infra",
  design: "Design",
  docs: "Docs",
  research: "Research",
  other: "Other",
};

/** One-line hint shown next to the label on every note. */
export const KIND_HINT: Record<ObsidianKind, string> = {
  feature: "New capability work",
  bugfix: "Fix for broken behavior",
  refactor: "Restructure without changing behavior",
  infra: "Infrastructure, tooling and CI",
  design: "Architecture decision record",
  docs: "Documentation",
  research: "Investigation and findings",
  other: "Unclassified work",
};

// ─── Rendered output ────────────────────────────────────────────────────────

/** What a renderer produces (never a full file by itself — see mergeNote). */
export type RenderedNote = {
  /** Frontmatter + auto block only: the idempotency hash input. */
  autoPayload: string;
  /** `autoPayload` + the default human queue (what a first write looks like). */
  markdown: string;
};

// ─── Inputs (normalized, DB-free) ───────────────────────────────────────────

/** A task referenced (and wiki-linked) from a plan note. */
export type PlanNoteTaskRef = {
  id: string;
  orderIndex: number;
  /** Display title; falls back to the first line of `description`, then the id. */
  title?: string | null | undefined;
  description?: string | null | undefined;
  status: string;
  kind: ObsidianKind;
  /** Vault-relative note path (`Projects/<tag>/<folder>/<file>.md`). Wins over `file`. */
  path?: string | null | undefined;
  /** Bare filename fallback (`<file>.md`) — placed in the task's kind folder. */
  file?: string | null | undefined;
};

/** Input for {@link renderPlanNote}. `kind` is already resolved upstream. */
export type PlanNoteInput = {
  id: string;
  slug: string;
  title: string;
  status: string;
  priority: number;
  kind: ObsidianKind;
  overview: string;
  approach?: string | null | undefined;
  complexity?: number | null | undefined;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number | null | undefined;
  completedAt?: number | null | undefined;
  projectTag: string;
  /** Rendered sorted by `orderIndex` (input order is irrelevant). */
  tasks?: PlanNoteTaskRef[] | undefined;
};

/** Input for {@link renderTaskNote}. */
export type TaskNoteInput = {
  id: string;
  planId: string;
  planSlug: string;
  orderIndex: number;
  description: string;
  agent?: string | null | undefined;
  status: string;
  complexity?: number | null | undefined;
  result?: string | null | undefined;
  error?: string | null | undefined;
  files?: readonly string[] | null | undefined;
  kind: ObsidianKind;
  projectTag: string;
  createdAt?: number | null | undefined;
  completedAt?: number | null | undefined;
};

/** Input for {@link renderDesignNote}. */
export type DesignNoteInput = {
  id: string;
  slug: string;
  title: string;
  status?: string | null | undefined;
  /** Pre-formatted date (`YYYY-MM-DD`), rendered verbatim. */
  date: string;
  projectPath: string;
  sourceFilename: string;
  /** Project-relative source path (`.ndomo/designs/<file>.md`). */
  sourcePath: string;
  /** Full source document (rendered under `## Content`). */
  body: string;
  kind: ObsidianKind;
  projectTag: string;
};

/** Input for {@link renderMemoryNote}. */
export type MemoryNoteInput = {
  id: string;
  content: string;
  type: string;
  tags: readonly string[];
  source?: string | null | undefined;
  createdAt: number;
  updatedAt: number;
  kind: ObsidianKind;
  projectTag: string;
};

// ─── YAML frontmatter (no external dependency, stable key order) ────────────

/** One `key: value` pair; a `null` value omits the key entirely. */
type YamlEntry = readonly [key: string, value: string | null];

/**
 * Single-quote YAML scalar: `'` → `''` (the only escape single-quoted YAML
 * needs) and newlines collapse to a space (a raw newline would break the
 * scalar). Backslashes and double quotes need no escaping when quoted.
 */
function yamlString(value: string): string {
  const flat = value.replace(/[\r\n]+/g, " ");
  return `'${flat.replace(/'/g, "''")}'`;
}

/** Finite numbers render bare (`2`); anything else → `null` (key omitted). */
function yamlNumber(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

/** Epoch ms → `'ISO-8601'`; non-finite/out-of-range → `null` (never throws). */
function isoDate(ts: number | null | undefined): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  try {
    return new Date(ts).toISOString();
  } catch {
    return null;
  }
}

/** {@link isoDate} as a quoted YAML scalar (frontmatter form). */
function yamlDate(ts: number | null | undefined): string | null {
  const iso = isoDate(ts);
  return iso === null ? null : yamlString(iso);
}

/** YAML list value: `[]` when empty, otherwise an indented `- item` block. */
function yamlList(values: readonly string[]): string {
  const clean = values.map((value) => value.trim()).filter((value) => value !== "");
  if (clean.length === 0) return "[]";
  return `\n  - ${clean.map(yamlString).join("\n  - ")}`;
}

/** Serialize `---`-delimited frontmatter with a stable key order. */
function buildFrontmatter(entries: readonly YamlEntry[]): string {
  const lines = ["---"];
  for (const [key, value] of entries) {
    if (value === null) continue;
    lines.push(value.startsWith("\n") ? `${key}:${value}` : `${key}: ${value}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

// ─── Body helpers ───────────────────────────────────────────────────────────

/** Trimmed value, or `null` when the value is absent / blank. */
function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** `## <title>` section, omitted when the content is missing/blank. */
function section(title: string, content: string | null | undefined): string[] {
  const trimmed = trimmedOrNull(content);
  if (trimmed === null) return [];
  return ["", `## ${title}`, "", trimmed];
}

/** First non-blank line of a free-form text (used to derive note titles). */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** Single-line H1 text: newlines/spaces collapse, blank → `Untitled`. */
function heading(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single === "" ? "Untitled" : single;
}

/** Strip the characters that would break a `[[target|label]]` link. */
function wikiLabel(text: string): string {
  return text
    .replace(/[[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop a trailing `.md` (and stray `./`) from a link target. */
function stripExtension(path: string): string {
  return path.replace(/\.md$/i, "").replace(/^\.\//, "");
}

/** `Projects/<tag>` namespace of a note (matches `projectRoot()`). */
function projectNamespace(projectTag: string): string {
  return `${PROJECTS_FOLDER}/${sanitizeSegment(projectTag)}`;
}

/** Absolute-looking inputs are trimmed down to a vault-relative link target. */
function vaultTarget(projectTag: string, folder: string, file: string): string {
  return `${projectNamespace(projectTag)}/${folder}/${stripExtension(file)}`;
}

/**
 * Wiki target for a task referenced from a plan note.
 * `path` (vault-relative, produced by `taskNotePath` + `toVaultRelative`) wins
 * over `file` (bare filename → dropped into the task's kind folder).
 * Returns `null` when neither carries a usable value: the task is then
 * rendered as plain text instead of a broken link.
 */
function taskLinkTarget(
  projectTag: string,
  kind: ObsidianKind,
  ref: PlanNoteTaskRef,
): string | null {
  const candidates = [ref.path, ref.file];
  const raw = candidates.find((value): value is string => {
    return typeof value === "string" && value.trim() !== "";
  });
  if (raw === undefined) return null;

  const cleaned = stripExtension(raw.trim().replace(/\\/g, "/").replace(/^\/+/, ""));
  if (cleaned === "") return null;
  if (!cleaned.includes("/")) return vaultTarget(projectTag, FOLDER_BY_KIND[kind], cleaned);
  if (!cleaned.startsWith(`${PROJECTS_FOLDER}/`)) {
    return `${projectNamespace(projectTag)}/${cleaned}`;
  }
  return cleaned;
}

/** Display title of a referenced task: title → first description line → id. */
function taskDisplayTitle(ref: PlanNoteTaskRef): string {
  const title = ref.title ?? null;
  if (title !== null && title.trim() !== "") return title.trim();
  const description = ref.description ?? null;
  if (description !== null) {
    const line = firstLine(description);
    if (line !== "") return line;
  }
  return ref.id;
}

/** `- [[target|Title]] — \`status\`` (or plain text when no target exists). */
function taskListLine(projectTag: string, ref: PlanNoteTaskRef): string {
  const label = wikiLabel(taskDisplayTitle(ref));
  const target = taskLinkTarget(projectTag, ref.kind, ref);
  const link = target === null ? label : `[[${target}|${label}]]`;
  return `- ${link} — \`${ref.status}\``;
}

/**
 * Free-form input can quote a marker verbatim (agents paste rendered notes
 * back into `result` / `body` / design content). A stray marker inside the
 * managed block would break {@link extractHumanSection}, so generated text is
 * rendered with the hyphenated look-alike: the payload then carries each
 * marker EXACTLY ONCE, at the boundary — the invariant `mergeNote` relies on.
 */
function defuseMarkers(text: string): string {
  return text.replaceAll(AUTO_START, DEFUSED_START).replaceAll(AUTO_END, DEFUSED_END);
}

/** Assemble frontmatter + auto block + default human queue. */
function buildNote(frontmatter: string, body: readonly string[]): RenderedNote {
  const safeFrontmatter = defuseMarkers(frontmatter);
  const safeBody = defuseMarkers(body.join("\n"));
  const autoPayload = `${safeFrontmatter}${AUTO_START}\n${safeBody}\n${AUTO_END}`;
  return { autoPayload, markdown: `${autoPayload}${DEFAULT_HUMAN_SECTION}` };
}

// ─── Renderers ──────────────────────────────────────────────────────────────

/** Render a plan note (10-Plans) with its linked task list. */
export function renderPlanNote(input: PlanNoteInput): RenderedNote {
  const tasks = [...(input.tasks ?? [])].sort((a, b) => a.orderIndex - b.orderIndex);
  const priority = yamlNumber(input.priority);
  const complexity = yamlNumber(input.complexity ?? null);

  const frontmatter = buildFrontmatter([
    ["ndomoEntity", yamlString("plan")],
    ["ndomoId", yamlString(input.id)],
    ["ndomoKind", yamlString(input.kind)],
    ["ndomoProjectTag", yamlString(input.projectTag)],
    ["title", yamlString(input.title)],
    ["status", yamlString(input.status)],
    ["slug", yamlString(input.slug)],
    ["priority", priority],
    ["complexity", complexity],
    ["createdAt", yamlDate(input.createdAt)],
    ["updatedAt", yamlDate(input.updatedAt)],
    ["approvedAt", yamlDate(input.approvedAt ?? null)],
    ["completedAt", yamlDate(input.completedAt ?? null)],
  ]);

  const body: string[] = [
    `# ${heading(input.title)}`,
    "",
    `> **${KIND_LABEL[input.kind]}** — ${KIND_HINT[input.kind]}`,
    "",
    `- **Status:** \`${input.status}\``,
  ];
  if (priority !== null) body.push(`- **Priority:** \`${priority}\``);
  if (complexity !== null) body.push(`- **Complexity:** \`${complexity}\``);

  body.push(...section("Overview", input.overview));
  body.push(...section("Approach", input.approach ?? null));

  if (tasks.length > 0) {
    body.push("", `## Tasks (${tasks.length})`, "");
    for (const task of tasks) body.push(taskListLine(input.projectTag, task));
  }

  return buildNote(frontmatter, body);
}

/**
 * Render a task note (folder comes from `kind`, see `taskNotePath`).
 * The `## Description` section is only emitted for multi-line descriptions —
 * a single-line one already is the H1, and duplicating it would be noise.
 */
export function renderTaskNote(input: TaskNoteInput): RenderedNote {
  const title = heading(firstLine(input.description));
  const planTarget = vaultTarget(input.projectTag, PLANS_FOLDER, input.planSlug);
  const planLink = `[[${planTarget}|${wikiLabel(input.planSlug)}]]`;
  const orderIndex = yamlNumber(input.orderIndex);
  const complexity = yamlNumber(input.complexity ?? null);
  const agent = trimmedOrNull(input.agent);

  const frontmatter = buildFrontmatter([
    ["ndomoEntity", yamlString("task")],
    ["ndomoId", yamlString(input.id)],
    ["ndomoKind", yamlString(input.kind)],
    ["ndomoProjectTag", yamlString(input.projectTag)],
    ["title", yamlString(title)],
    ["status", yamlString(input.status)],
    ["plan", yamlString(planLink)],
    ["planId", yamlString(input.planId)],
    ["planSlug", yamlString(input.planSlug)],
    ["orderIndex", orderIndex],
    ["complexity", complexity],
    ["createdAt", yamlDate(input.createdAt ?? null)],
    ["completedAt", yamlDate(input.completedAt ?? null)],
  ]);

  const body: string[] = [
    `# ${title}`,
    "",
    `> **${KIND_LABEL[input.kind]}** — ${KIND_HINT[input.kind]}`,
    "",
    `- **Status:** \`${input.status}\``,
    `- **Plan:** ${planLink}`,
  ];
  if (orderIndex !== null) body.push(`- **Order:** \`${orderIndex}\``);
  if (agent !== null) body.push(`- **Agent:** \`${agent}\``);
  if (complexity !== null) body.push(`- **Complexity:** \`${complexity}\``);

  const description = trimmedOrNull(input.description);
  if (description?.includes("\n")) {
    body.push(...section("Description", description));
  }
  body.push(...section("Result", input.result ?? null));
  body.push(...section("Error", input.error ?? null));

  const files = (input.files ?? []).filter((file) => file.trim() !== "");
  if (files.length > 0) {
    body.push("", "## Files", "");
    for (const file of files) body.push(`- \`${file}\``);
  }

  return buildNote(frontmatter, body);
}

/** Render a design note (50-Designs) from the `.ndomo/designs/` source doc. */
export function renderDesignNote(input: DesignNoteInput): RenderedNote {
  const date = trimmedOrNull(input.date);
  const status = trimmedOrNull(input.status);
  const frontmatter = buildFrontmatter([
    ["ndomoEntity", yamlString("design")],
    ["ndomoId", yamlString(input.id)],
    ["ndomoKind", yamlString(input.kind)],
    ["ndomoProjectTag", yamlString(input.projectTag)],
    ["title", yamlString(input.title)],
    ["status", status === null ? null : yamlString(status)],
    ["slug", yamlString(input.slug)],
    ["sourcePath", yamlString(input.sourcePath)],
    ["date", date === null ? null : yamlString(date)],
  ]);

  const body: string[] = [
    `# ${heading(input.title)}`,
    "",
    `> **${KIND_LABEL[input.kind]}** — ${KIND_HINT[input.kind]}`,
    "",
  ];
  if (date !== null) body.push(`- **Date:** \`${date}\``);
  if (status !== null) body.push(`- **Status:** \`${status}\``);
  if (input.projectPath.trim() !== "") {
    body.push(`- **Repository:** \`${input.projectPath}\``);
  }
  body.push(`- **Source:** \`${input.sourcePath}\``);

  body.push(...section("Content", input.body));

  return buildNote(frontmatter, body);
}

/** Render a memory note (95-Memories — deliberate exception to kind→folder). */
export function renderMemoryNote(input: MemoryNoteInput): RenderedNote {
  const title = heading(firstLine(input.content));
  const tags = input.tags.map((tag) => tag.trim()).filter((tag) => tag !== "");
  const source = trimmedOrNull(input.source);

  const frontmatter = buildFrontmatter([
    ["ndomoEntity", yamlString("memory")],
    ["ndomoId", yamlString(input.id)],
    ["ndomoKind", yamlString(input.kind)],
    ["ndomoProjectTag", yamlString(input.projectTag)],
    ["title", yamlString(title)],
    ["type", yamlString(input.type)],
    ["tags", yamlList(tags)],
    ["source", source === null ? null : yamlString(source)],
    ["createdAt", yamlDate(input.createdAt)],
    ["updatedAt", yamlDate(input.updatedAt)],
  ]);

  const body: string[] = [
    `# ${title}`,
    "",
    `> **${KIND_LABEL[input.kind]}** — ${KIND_HINT[input.kind]}`,
    "",
    `- **Type:** \`${input.type}\``,
  ];
  if (tags.length > 0) body.push(`- **Tags:** ${tags.map((tag) => `\`${tag}\``).join(", ")}`);
  if (source !== null) body.push(`- **Source:** \`${source}\``);
  const created = isoDate(input.createdAt);
  if (created !== null) body.push(`- **Created:** \`${created}\``);

  body.push(...section("Content", input.content));

  return buildNote(frontmatter, body);
}

// ─── Merge / migration ──────────────────────────────────────────────────────

/**
 * Offset where the auto block may start: right after the closing `---` fence.
 * Marker text inside the managed frontmatter (a title containing the literal
 * `%% ndomo:auto:end %%`, say) must never be mistaken for the real marker.
 */
function autoBlockOffset(markdown: string): number {
  if (!markdown.startsWith("---\n")) return 0;
  const fence = markdown.indexOf("\n---\n", 4);
  return fence === -1 ? 0 : fence + "\n---\n".length;
}

/** Index of the real `AUTO_END` (searched after the frontmatter), else `-1`. */
function autoEndIndex(markdown: string): number {
  return markdown.indexOf(AUTO_END, autoBlockOffset(markdown));
}

/**
 * Human-owned tail of an existing note: everything after `AUTO_END`,
 * including the newline that immediately follows it.
 * No marker → {@link DEFAULT_HUMAN_SECTION}.
 */
export function extractHumanSection(existing: string | null): string {
  if (existing === null) return DEFAULT_HUMAN_SECTION;
  const end = autoEndIndex(existing);
  return end === -1 ? DEFAULT_HUMAN_SECTION : existing.slice(end + AUTO_END.length);
}

/**
 * Combine freshly generated content with what is already on disk.
 * The human tail is copied verbatim when the existing note carries the
 * markers; otherwise (fresh or foreign file) the generated default wins and
 * the frontmatter + auto block are always regenerated.
 */
export function mergeNote(generated: RenderedNote, existing: string | null): string {
  if (existing === null || autoEndIndex(existing) === -1) return generated.markdown;
  return `${generated.autoPayload}${extractHumanSection(existing)}`;
}

// ─── Vault containment (symlink escape guard for note I/O) ──────────────────

/** Realpath verdict for one candidate path. */
type Containment =
  /** Nothing at that path (or a dangling symlink) — nothing to leak. */
  | { kind: "absent" }
  /** Canonical path IS the canonical vault root (climbing stops here). */
  | { kind: "root" }
  /** Canonical path sits strictly below the canonical vault root. */
  | { kind: "inside"; realPath: string }
  /** Canonical path leaves the vault (symlink pointing outside it). */
  | { kind: "outside"; realPath: string };

/**
 * Canonicalize `target` and compare it against the canonical vault root.
 * Non-ENOENT errnos (EACCES, ELOOP, …) propagate: OBL-3 maps them to the
 * `VAULT_UNWRITABLE` / `IO_ERROR` envelope instead of hiding them as "absent".
 */
function containmentOf(root: string, target: string): Containment {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw err;
  }

  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // Root not canonicalizable (not created yet): fall back to the lexical
    // root so the comparison stays strict instead of silently passing.
  }

  if (realTarget === realRoot) return { kind: "root" };
  const rel = relative(realRoot, realTarget);
  const inside = !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  return inside
    ? { kind: "inside", realPath: realTarget }
    : { kind: "outside", realPath: realTarget };
}

/**
 * Read a note only when its REAL path stays inside the vault.
 *
 * Lexical containment is not enough: `readFileIfExists` follows symlinks, so
 * a note swapped for `ln -s /etc/passwd <note>` (or an `oldPath` planted by a
 * malicious sync-state) would drag foreign — possibly secret — content into
 * the projection. Both `absent` and `outside` answer `null`, which makes
 * {@link mergeNote} fall back to the DEFAULT human queue: an escaping file is
 * neither read nor copied, only ignored.
 *
 * Known limitation (mirrors read.ts): the containment check and the read are
 * not atomic — a symlink swapped in that TOCTOU window could be followed.
 * Acceptable for a local, user-owned vault; `O_NOFOLLOW`-style reads would be
 * the strict fix.
 */
function readNoteContained(root: string, target: string): string | null {
  const verdict = containmentOf(root, target);
  if (verdict.kind !== "inside") return null;
  return readFileIfExists(target);
}

/**
 * Refuse to WRITE through a path whose parent chain leaves the vault.
 *
 * Writing a plain symlink itself is harmless — `rename(2)` REPLACES the final
 * component instead of following it — so only the ANCESTORS are checked: a
 * symlinked directory would redirect `mkdir -p` + `rename` outside the vault.
 * Ancestors that do not exist yet are created by this call, so the walk climbs
 * until it finds an existing one (or the vault root itself).
 *
 * @returns `null` when the target is safe, or the escaping canonical path.
 */
function escapingWriteTarget(root: string, target: string): string | null {
  if (!existsSync(root)) {
    // Root does not exist yet → nothing below it can exist either → every
    // component of the write is created by us (mkdir -p + temp + rename).
    return null;
  }

  let cursor = dirname(target);
  for (;;) {
    const verdict = containmentOf(root, cursor);
    if (verdict.kind === "absent") {
      const parent = dirname(cursor);
      // Climb past the fs root without finding anything existing to compare
      // against: reject conservatively (a caller passing a foreign path).
      if (parent === cursor) return cursor;
      cursor = parent;
      continue;
    }
    // `root` and anything below it is where this write belongs; anything else
    // (a symlinked directory escaping the vault) is refused.
    return verdict.kind === "outside" ? verdict.realPath : null;
  }
}

/**
 * Write the note to `newPath`, carrying the human section over from `oldPath`
 * when the kind change moved the file to another folder (the old file is then
 * deleted). `oldPath === newPath` (or `null`) merges against the current file.
 *
 * **Symlink policy (documented decision):**
 * - Both reads ({@link readNoteContained}) refuse targets whose real path
 *   leaves `vaultRoot`: foreign content is never merged into a note, the
 *   DEFAULT human queue wins instead. An escaping `oldPath` is neither read
 *   nor deleted (deleting a target that is not ours is not this tool's call).
 * - The final path component may itself be a symlink: `rename(2)` REPLACES it
 *   (the link is unlinked, its target untouched), which heals a note that was
 *   swapped for a link instead of following it. An escaping parent DIRECTORY
 *   is the only write {@link escapingWriteTarget} rejects (throws).
 *
 * @param params.vaultRoot Canonical root the note must stay inside (required:
 *   without it a stray `oldPath`/`newPath` could slurp host files).
 * @throws Whatever the fs helpers throw (ENOENT is tolerated by them), plus a
 *   plain `Error` when a parent directory of `newPath` escapes the vault —
 *   OBL-3 maps both to an error envelope (`IO_ERROR`).
 */
export function resolveNoteContent(params: {
  vaultRoot: string;
  newPath: string;
  oldPath: string | null;
  generated: RenderedNote;
}): { content: string; migratedFrom: string | null } {
  const { vaultRoot, newPath, oldPath, generated } = params;

  const escaping = escapingWriteTarget(vaultRoot, newPath);
  if (escaping !== null) {
    throw new Error(
      `ndomo: refusing to write "${newPath}": its real target (${escaping}) is outside the vault ${vaultRoot}`,
    );
  }

  if (oldPath !== null && oldPath !== newPath) {
    const previous = readNoteContained(vaultRoot, oldPath);
    if (previous !== null) {
      const content = mergeNote(generated, previous);
      atomicWriteFileSync(newPath, content);
      deleteFileIfExists(oldPath);
      return { content, migratedFrom: oldPath };
    }
  }

  const content = mergeNote(generated, readNoteContained(vaultRoot, newPath));
  atomicWriteFileSync(newPath, content);
  return { content, migratedFrom: null };
}

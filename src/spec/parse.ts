/**
 * ndomo spec — markdown parser for spec documents.
 *
 * A spec file is YAML frontmatter + `## N. Title` sections (canonical order
 * 1..13), with `### REQ-NNN` requirement blocks under section 5 and a
 * traceability table under section 11.
 *
 * Parsing is a pure string → {@link SpecDocument} transformation: no I/O, no
 * AI, no clock. The parser tracks fenced code blocks line-by-line so headings
 * inside ``` fences (templates document their own format there) never produce
 * phantom sections, requirements or matrix rows.
 *
 * Line numbers are 1-based and always refer to the original file layout.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Lifecycle status of a spec document (frontmatter `status`). */
export type SpecStatus =
  | "draft"
  | "in-review"
  | "approved"
  | "implementing"
  | "verified"
  | "deprecated";

/** Lifecycle status of a single requirement (meta bullet `status`). */
export type SpecReqStatus = "active" | "deferred" | "dropped" | "deprecated";

/** A parsed acceptance criterion (`- AC-NNN-M:` bullet or `#### AC-NNN-M` heading). */
export interface SpecAc {
  id: string;
  /** 1-based line of the AC bullet/heading. */
  line: number;
  /** Full AC text including the Given/When/Then markers. */
  text: string;
  /** Text between `**Given**` and the next marker, when present. */
  given?: string;
  /** Text between `**When**` and the next marker, when present. */
  when?: string;
  /** Text after `**Then**`, when present. */
  then?: string;
}

/** A parsed requirement (`### REQ-NNN` heading under section 5). */
export interface SpecRequirement {
  id: string;
  title: string;
  /** 1-based line of the `### REQ-NNN` heading. */
  line: number;
  type?: string;
  priority?: string;
  owner?: string;
  /** Defaults to `active` when the meta bullet omits it. */
  status: SpecReqStatus;
  acs: SpecAc[];
  /** Raw block text below the heading (prose + ACs + meta bullets), trimmed. */
  body: string;
}

/** A parsed `## N. Title` section. */
export interface SpecSection {
  number: number;
  title: string;
  /** 1-based line of the `## N.` heading (same as {@link startLine}). */
  line: number;
  /** Section text below the heading, with blank edges trimmed. */
  body: string;
  /** 1-based line of the heading. */
  startLine: number;
  /** 1-based line of the last non-blank body line (equals startLine when empty). */
  endLine: number;
}

/** A row of the section 11 traceability matrix. */
export interface SpecMatrixRow {
  req: string;
  ac: string;
  tasks: string;
  tests: string;
  state: string;
  /** 1-based line of this data row (not the table header). */
  line: number;
}

/** Parsed spec document. */
export interface SpecDocument {
  frontmatter: Record<string, string | string[] | undefined>;
  sections: SpecSection[];
  requirements: SpecRequirement[];
  matrix: SpecMatrixRow[];
  /** Original markdown source (byte-for-byte). */
  raw: string;
  /** Echo of the source path when the caller provided one. */
  sourcePath?: string;
}

/** Options for {@link parseSpec}. */
export interface ParseSpecOptions {
  sourcePath?: string | undefined;
}

// ─── Frontmatter scan (shared with lint) ─────────────────────────────────────

/** Result of scanning a YAML-ish frontmatter block. */
export interface FrontmatterScan {
  /** Key → value. Scalars are trimmed strings, lists are string[], empty values are `undefined`. */
  values: Record<string, string | string[] | undefined>;
  /** Key → 1-based line of its `key:` declaration. */
  keyLines: Map<string, number>;
  /** Lines inside the block that are not `key: value` nor list items. */
  malformed: { line: number; text: string }[];
  /** 1-based line of the opening `---` (0 when there is no frontmatter block). */
  startLine: number;
  /** 1-based line of the closing `---` (last line when unterminated, 0 when absent). */
  endLine: number;
}

const FRONTMATTER_KEY_RE = /^([A-Za-z_][\w-]*):\s*(.*)$/;
const FRONTMATTER_LIST_RE = /^\s+-\s+(.*)$/;

/**
 * Scan the leading `---` block of `raw` without a YAML dependency.
 *
 * Tolerated shapes (SPEC-001 uses all of them):
 *  - `key: scalar`
 *  - `key:` followed by indented `- item` lines (becomes string[])
 *  - `key: []` (becomes an empty array)
 *  - unknown/extra keys (kept verbatim)
 *
 * The scan never throws: malformed lines are collected for the linter (L1).
 */
export function scanFrontmatter(raw: string): FrontmatterScan {
  const lines = raw.split("\n");
  const values: Record<string, string | string[] | undefined> = {};
  const keyLines = new Map<string, number>();
  const malformed: { line: number; text: string }[] = [];

  if ((lines[0] ?? "").trim() !== "---") {
    return { values, keyLines, malformed, startLine: 0, endLine: 0 };
  }

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      closeIndex = i;
      break;
    }
  }
  // Unterminated block: parse to EOF (L1 missing-key findings still fire).
  const lastContent = closeIndex === -1 ? lines.length - 1 : closeIndex - 1;

  let lastKey: string | undefined;
  for (let i = 1; i <= lastContent; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    if (line.trim().length === 0) continue;

    const listItem = FRONTMATTER_LIST_RE.exec(line);
    if (listItem) {
      if (lastKey === undefined) {
        malformed.push({ line: lineNo, text: line.trim() });
        continue;
      }
      const current = values[lastKey];
      const item = (listItem[1] ?? "").trim();
      if (Array.isArray(current)) current.push(item);
      else if (current === undefined) values[lastKey] = [item];
      else malformed.push({ line: lineNo, text: line.trim() }); // scalar then list: malformed
      continue;
    }

    const kv = FRONTMATTER_KEY_RE.exec(line);
    if (kv) {
      const key = kv[1] ?? "";
      const rawValue = (kv[2] ?? "").trim();
      lastKey = key;
      keyLines.set(key, lineNo);
      if (rawValue === "") values[key] = undefined;
      else if (rawValue === "[]") values[key] = [];
      else values[key] = rawValue;
      continue;
    }

    malformed.push({ line: lineNo, text: line.trim() });
    lastKey = undefined;
  }

  return {
    values,
    keyLines,
    malformed,
    startLine: 1,
    endLine: closeIndex === -1 ? lines.length : closeIndex + 1,
  };
}

// ─── Fence tracking (shared with lint/serialize) ─────────────────────────────

/**
 * Mark every line that belongs to a fenced code block (``` or ~~~, with or
 * without an info string). Used to ignore headings/markers inside fences.
 * The opener and closer lines themselves are marked as part of the fence.
 */
export function scanFences(lines: string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  let open: { char: string; len: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const token = m?.[1] ?? "";
    if (open === null) {
      if (m) {
        flags[i] = true;
        open = { char: token.charAt(0), len: token.length };
      }
      continue;
    }
    flags[i] = true;
    const rest = (m?.[2] ?? "").trim();
    const isCloser =
      m !== null && token.charAt(0) === open.char && token.length >= open.len && rest === "";
    if (isCloser) open = null;
  }
  return flags;
}

// ─── Section scan ────────────────────────────────────────────────────────────

const SECTION_HEADING_RE = /^## (\d+)\.\s+(.*)$/;
const REQ_HEADING_RE = /^###\s+(REQ-\S*)(.*)$/i;
const ANY_H3_RE = /^###\s+/;
const AC_BULLET_RE = /^-\s+(AC-[^\s:]+)\s*:\s*(.*)$/;
const AC_HEADING_RE = /^####\s+(AC-[^\s:]+)\s*:?\s*(.*)$/;
const META_PAIR_RE = /^(?:\*\*)?(type|priority|owner|status)(?:\*\*)?\s*:\s*(.+)$/i;

interface NumberedLine {
  text: string;
  /** 1-based absolute line number in the original document. */
  line: number;
}

/** A section heading plus its numbered body lines (blank edges trimmed). */
interface SectionParts {
  section: SpecSection;
  bodyLines: NumberedLine[];
}

function scanSections(lines: string[], fence: boolean[]): SectionParts[] {
  const headingIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    if (SECTION_HEADING_RE.test(lines[i] ?? "")) headingIndexes.push(i);
  }

  const parts: SectionParts[] = [];
  for (const [position, index] of headingIndexes.entries()) {
    const m = SECTION_HEADING_RE.exec(lines[index] ?? "");
    if (m === null) continue;
    const next = headingIndexes[position + 1] ?? lines.length;
    const rawBody: NumberedLine[] = [];
    for (let i = index + 1; i < next; i++) rawBody.push({ text: lines[i] ?? "", line: i + 1 });

    let start = 0;
    let end = rawBody.length;
    while (start < end && (rawBody[start]?.text ?? "").trim() === "") start++;
    while (end > start && (rawBody[end - 1]?.text ?? "").trim() === "") end--;
    const bodyLines = rawBody.slice(start, end);

    const startLine = index + 1;
    const section: SpecSection = {
      number: Number(m[1] ?? "0"),
      title: (m[2] ?? "").trim(),
      line: startLine,
      body: bodyLines.map((l) => l.text).join("\n"),
      startLine,
      endLine: bodyLines.at(-1)?.line ?? startLine,
    };
    parts.push({ section, bodyLines });
  }
  return parts;
}

// ─── Requirement scan (section 5) ────────────────────────────────────────────

/** Extract Given/When/Then slices from an AC text (markers in any order). */
function extractGwt(text: string): Pick<SpecAc, "given" | "when" | "then"> {
  const markers = [...text.matchAll(/\*\*(Given|When|Then)\*\*/gi)].map((m) => ({
    key: (m[1] ?? "").toLowerCase() as "given" | "when" | "then",
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  if (markers.length === 0) return {};
  markers.sort((a, b) => a.start - b.start);

  const out: Pick<SpecAc, "given" | "when" | "then"> = {};
  for (const [i, marker] of markers.entries()) {
    const sliceEnd = markers[i + 1]?.start ?? text.length;
    const value = text
      .slice(marker.end, sliceEnd)
      .replace(/^[\s,:;-]+/, "")
      .replace(/[\s,:;-]+$/, "")
      .trim();
    if (value.length > 0 && !(marker.key in out)) out[marker.key] = value;
  }
  return out;
}

function parseRequirements(bodyLines: NumberedLine[], fence: boolean[]): SpecRequirement[] {
  const isLive = (l: NumberedLine): boolean => !fence[l.line - 1];

  /**
   * Meta `status` must stay inside the {@link SpecReqStatus} union. Unknown
   * values normalize to `active` (strict default: only an explicit
   * deferred/dropped/deprecated status opts a requirement out of L5/L6).
   */
  function normalizeReqStatus(raw: string | undefined): SpecReqStatus {
    const value = raw ?? "active";
    return (
      value === "deferred" || value === "dropped" || value === "deprecated" ? value : "active"
    ) as SpecReqStatus;
  }

  // REQ heading positions (relative to bodyLines).
  const heads: number[] = [];
  for (const [i, l] of bodyLines.entries()) {
    if (!isLive(l)) continue;
    if (REQ_HEADING_RE.test(l.text)) heads.push(i);
  }

  const requirements: SpecRequirement[] = [];
  for (const headIndex of heads) {
    const head = bodyLines[headIndex];
    if (head === undefined) continue;
    const m = REQ_HEADING_RE.exec(head.text);
    if (m === null) continue;

    // Block ends at the next H3 (REQ or not) or the end of the section.
    let blockEnd = bodyLines.length;
    for (let i = headIndex + 1; i < bodyLines.length; i++) {
      const l = bodyLines[i];
      if (l !== undefined && isLive(l) && ANY_H3_RE.test(l.text)) {
        blockEnd = i;
        break;
      }
    }
    const block = bodyLines.slice(headIndex + 1, blockEnd);

    const id = m[1] ?? "";
    const rest = m[2] ?? "";
    const title = rest.replace(/^\s*[-–—]\s+/, "").trim();

    // Meta bullets (single-line `·` form and `**Key**` form).
    const meta: { type?: string; priority?: string; owner?: string; status?: string } = {};
    for (const l of block) {
      if (!isLive(l)) continue;
      const bullet = /^-\s+(.*)$/.exec(l.text);
      if (!bullet) continue;
      for (const segment of (bullet[1] ?? "").split(" · ")) {
        const pair = META_PAIR_RE.exec(segment.trim());
        if (!pair) continue;
        const key = (pair[1] ?? "").toLowerCase();
        const value = (pair[2] ?? "").trim();
        if (value.length === 0) continue;
        if (key === "type") meta.type = value;
        else if (key === "priority") meta.priority = value;
        else if (key === "owner") meta.owner = value;
        else meta.status = value;
      }
    }

    // Acceptance criteria: bullet form (with indented continuation lines) and
    // heading form (with paragraph continuation until blank/next heading).
    const acs: SpecAc[] = [];
    for (let i = 0; i < block.length; i++) {
      const l = block[i];
      if (l === undefined || !isLive(l)) continue;

      const bullet = AC_BULLET_RE.exec(l.text);
      const heading = bullet === null ? AC_HEADING_RE.exec(l.text) : null;
      if (bullet === null && heading === null) continue;

      const idPart = (bullet?.[1] ?? heading?.[1] ?? "").trim();
      const pieces: string[] = [(bullet?.[2] ?? heading?.[2] ?? "").trim()];
      let j = i + 1;
      if (bullet !== null) {
        // Continuations: indented, non-blank, not a new bullet or heading.
        while (j < block.length) {
          const next = block[j];
          if (next === undefined || !isLive(next) || next.text.trim().length === 0) break;
          if (!/^\s/.test(next.text)) break;
          if (/^\s*-/.test(next.text) || /^\s*#/.test(next.text)) break;
          pieces.push(next.text.trim());
          j++;
        }
      } else {
        // Heading form: paragraph continuation until blank line, next heading
        // or the next top-level bullet (another AC or a meta bullet).
        while (j < block.length) {
          const next = block[j];
          if (next === undefined || !isLive(next) || next.text.trim().length === 0) break;
          if (/^#{1,4}\s/.test(next.text)) break;
          if (/^\s*-\s/.test(next.text)) break;
          pieces.push(next.text.trim());
          j++;
        }
      }
      i = j - 1;

      const text = pieces
        .filter((p) => p.length > 0)
        .join(" ")
        .trim();
      const ac: SpecAc = { id: idPart, line: l.line, text, ...extractGwt(text) };
      acs.push(ac);
    }

    const requirement: SpecRequirement = {
      id,
      title,
      line: head.line,
      status: normalizeReqStatus(meta.status),
      acs,
      body: block
        .map((l) => l.text)
        .join("\n")
        .replace(/^\s+|\s+$/g, ""),
    };
    if (meta.type !== undefined) requirement.type = meta.type;
    if (meta.priority !== undefined) requirement.priority = meta.priority;
    if (meta.owner !== undefined) requirement.owner = meta.owner;
    requirements.push(requirement);
  }
  return requirements;
}

// ─── Matrix scan (section 11) ────────────────────────────────────────────────

const MATRIX_HEADER_RE = /^\s*\|/;
const SEPARATOR_CELL_RE = /^:?-+:?$/;

function cellsOf(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function parseMatrix(bodyLines: NumberedLine[], fence: boolean[]): SpecMatrixRow[] {
  const isLive = (l: NumberedLine): boolean => !fence[l.line - 1];

  let headerIndex = -1;
  for (const [i, l] of bodyLines.entries()) {
    if (!isLive(l) || !MATRIX_HEADER_RE.test(l.text)) continue;
    const cells = cellsOf(l.text);
    if ((cells[0] ?? "").toLowerCase() === "req" && (cells[1] ?? "").toLowerCase() === "ac") {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return [];

  const rows: SpecMatrixRow[] = [];
  for (let i = headerIndex + 1; i < bodyLines.length; i++) {
    const l = bodyLines[i];
    if (l === undefined || !isLive(l)) break;
    const trimmed = l.text.trim();
    if (trimmed.length === 0) break;
    if (!MATRIX_HEADER_RE.test(l.text)) break;

    const cells = cellsOf(l.text);
    const isSeparator = cells.length > 0 && cells.every((c) => SEPARATOR_CELL_RE.test(c));
    if (isSeparator) continue; // `|---|---|` decoration line
    rows.push({
      req: cells[0] ?? "",
      ac: cells[1] ?? "",
      tasks: cells[2] ?? "",
      tests: cells[3] ?? "",
      state: cells[4] ?? "",
      line: l.line,
    });
  }
  return rows;
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Parse spec markdown into a {@link SpecDocument}. Pure and total: never throws
 * regardless of input shape (garbage in → empty/partial structures out; the
 * linter reports what is wrong).
 *
 * Fenced code blocks are skipped when scanning `## N.` sections, `### REQ-NNN`
 * headings and section 11 table rows, so templates can document their own
 * format inside fences without producing phantom entries.
 */
export function parseSpec(markdown: string, opts: ParseSpecOptions = {}): SpecDocument {
  const lines = markdown.split("\n");
  const fence = scanFences(lines);
  const frontmatter = scanFrontmatter(markdown);
  const parts = scanSections(lines, fence);

  const section5 = parts.find((p) => p.section.number === 5);
  const section11 = parts.find((p) => p.section.number === 11);

  const doc: SpecDocument = {
    frontmatter: frontmatter.values,
    sections: parts.map((p) => p.section),
    requirements: section5 ? parseRequirements(section5.bodyLines, fence) : [],
    matrix: section11 ? parseMatrix(section11.bodyLines, fence) : [],
    raw: markdown,
  };
  if (opts.sourcePath !== undefined) doc.sourcePath = opts.sourcePath;
  return doc;
}

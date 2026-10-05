/**
 * ndomo spec — canonical markdown serialization (pure, no I/O).
 *
 * `serializeSpec` renders a {@link SpecDocument} back to canonical markdown:
 * frontmatter in the fixed required-key order (extras keep their original
 * relative order after the fixed block), then `## N. Title` sections in
 * ascending numeric order, single blank line between blocks, exactly one
 * trailing newline.
 *
 * Round-trip guarantee: `parseSpec(serializeSpec(doc))` preserves frontmatter,
 * section numbers/titles/lines, requirements/ACs and matrix rows. Section
 * bodies are the source of truth for section content (requirements and the
 * matrix are derived from them at parse time), so prose is never lossy.
 *
 * The pre-section preamble (e.g. the `# SPEC-001 …` title line) has no
 * dedicated field in SpecDocument; it is recovered from `doc.raw` with the
 * same fence-aware scan the parser uses, so serializing a parsed document
 * never drops it.
 */

import type { SpecDocument } from "./parse.ts";
import { scanFences, scanFrontmatter } from "./parse.ts";

/** Frontmatter keys emitted first, in this exact order. */
export const FRONTMATTER_KEY_ORDER = [
  "id",
  "slug",
  "title",
  "status",
  "version",
  "owner",
  "created",
  "updated",
  "related_plans",
  "related_designs",
  "supersedes",
] as const;

const SECTION_HEADING_RE = /^## (\d+)\.\s+(.*)$/;

function renderFrontmatterValue(key: string, value: string | string[] | undefined): string {
  if (value === undefined) return `${key}:`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    return `${key}:\n${value.map((item) => `  - ${item}`).join("\n")}`;
  }
  return `${key}: ${value}`;
}

/**
 * Text between the frontmatter and the first `## N.` section heading, blank
 * edges trimmed. Uses the parser's fence scan so a fenced `## 9.` example in
 * the preamble cannot truncate it. Empty when there is no preamble.
 */
function extractPreamble(raw: string): string {
  if (raw.length === 0) return "";
  const lines = raw.split("\n");
  const fm = scanFrontmatter(raw);
  const fence = scanFences(lines);
  const start = fm.startLine > 0 ? fm.endLine : 0;
  for (let i = start; i < lines.length; i++) {
    if (fence[i]) continue;
    if (SECTION_HEADING_RE.test(lines[i] ?? "")) {
      return lines.slice(start, i).join("\n").trim();
    }
  }
  return lines.slice(start).join("\n").trim();
}

/**
 * Serialize a spec document to canonical markdown. Pure: same document in →
 * byte-identical string out.
 */
export function serializeSpec(doc: SpecDocument): string {
  const out: string[] = ["---"];
  const emitted = new Set<string>();

  for (const key of FRONTMATTER_KEY_ORDER) {
    if (key in doc.frontmatter) {
      out.push(renderFrontmatterValue(key, doc.frontmatter[key]));
      emitted.add(key);
    }
  }
  for (const key of Object.keys(doc.frontmatter)) {
    if (emitted.has(key)) continue;
    out.push(renderFrontmatterValue(key, doc.frontmatter[key]));
  }
  out.push("---");

  const preamble = extractPreamble(doc.raw);
  if (preamble.length > 0) out.push("", preamble);

  const sections = [...doc.sections].sort((a, b) => a.number - b.number);
  for (const section of sections) {
    out.push("", `## ${section.number}. ${section.title}`);
    const body = section.body.trim();
    if (body.length > 0) out.push("", body);
  }

  return `${out.join("\n")}\n`;
}

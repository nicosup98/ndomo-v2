/**
 * Minimal YAML frontmatter reader for the audit.
 *
 * ndomo agent files use a tiny, well-known subset of YAML: top-level scalar
 * keys (`model:`, `temperature:`, `mode:`) plus a nested `permission:` map that
 * can go three levels deep (`permission.bash."*": allow`). We deliberately do
 * NOT add a YAML dependency — this parser handles exactly that subset:
 *
 * - `key: value` scalars at indent 0
 * - `key:` starting a nested block, indented by spaces
 * - quoted keys/values (`"*": ask`, `'git status*': allow`) with `"`/`'` stripped
 * - `# comments` only when the line starts with `#` (values keep inline `#`)
 *
 * Anything else (lists, anchors, multi-line scalars) is ignored — the audit
 * only reads keys it knows about, so an unparsable line degrades to "absent".
 */

/** A nested permission entry: scalar value or a map of pattern → value. */
export type PermissionEntry = string | Record<string, string>;

/** Parsed frontmatter: top-level scalars + the `permission` block. */
export interface Frontmatter {
  /** Top-level scalar keys (indent 0), unquoted values trimmed. */
  scalars: Record<string, string>;
  /** `permission` block; absent when the file declares none. */
  permission: Record<string, PermissionEntry> | null;
  /** `true` when the file starts with a `---` fence. */
  present: boolean;
}

const FENCE = /^---\s*$/;

/**
 * Extract the frontmatter body (between the first `---` fence and the next one).
 * Returns `null` when the file has no frontmatter fence.
 */
function extractBody(content: string): string | null {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || !FENCE.test(lines[0] ?? "")) return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) return lines.slice(1, i).join("\n");
  }
  return null;
}

/** Strip matching single/double quotes from a YAML scalar or key. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Leading-space indent of a line (tabs are not used in ndomo frontmatter). */
function indentOf(line: string): number {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

/**
 * Parse `key: value` / `key:`. Returns `null` for blank lines and full-line
 * comments. Values keep everything after the FIRST colon (values may contain
 * colons, e.g. model ids like `opencode-go/mimo-v2.6-flash` never do, but
 * descriptions such as `Ranger (Sensory Analyzer): ...` do).
 */
function splitKey(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  return { key: unquote(trimmed.slice(0, colon)), value: unquote(trimmed.slice(colon + 1)) };
}

/**
 * Parse an agent `.md` frontmatter into {@link Frontmatter}.
 * Deterministic: same input → same output, no I/O, no clock.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const empty: Frontmatter = { scalars: {}, permission: null, present: false };
  const body = extractBody(content);
  if (body === null) return empty;

  const scalars: Record<string, string> = {};
  let permission: Record<string, PermissionEntry> | null = null;

  // Permission block state: current top-level key inside `permission:` and the
  // current nested map (when `bash:` opened a sub-block).
  let inPermission = false;
  let nestedKey: string | null = null;
  let nested: Record<string, string> | null = null;

  const flushNested = (): void => {
    if (inPermission && nestedKey !== null && nested !== null && permission !== null) {
      permission[nestedKey] = nested;
    }
    nestedKey = null;
    nested = null;
  };

  for (const line of body.split(/\r?\n/)) {
    const indent = indentOf(line);
    const parsed = splitKey(line);
    if (parsed === null) continue;

    if (indent === 0) {
      flushNested();
      inPermission = false;
      if (parsed.value === "") {
        if (parsed.key === "permission") {
          inPermission = true;
          permission = permission ?? {};
        }
      } else {
        scalars[parsed.key] = parsed.value;
      }
      continue;
    }

    if (!inPermission || permission === null) continue;

    if (indent <= 2) {
      // Direct child of `permission:` — either a scalar (`edit: allow`) or the
      // opening of a nested map (`bash:`).
      flushNested();
      if (parsed.value === "") {
        nestedKey = parsed.key;
        nested = {};
      } else {
        permission[parsed.key] = parsed.value;
      }
    } else if (nested !== null) {
      // Grandchild (`permission.bash."*": ask`).
      nested[parsed.key] = parsed.value;
    }
  }
  flushNested();

  return { scalars, permission, present: true };
}

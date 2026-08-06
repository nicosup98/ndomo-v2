/**
 * ndomo DB — Session continuity ledger (filesystem-backed, no DB).
 *
 * Each session gets a portable markdown file at
 * `<projectDir>/.ndomo/ledgers/{sessionId}.md` that persists the full
 * cross-session context: id, goal, plan id, state, key decisions, agent
 * history, and outcome. Survives process restarts and DB rebuilds so a
 * new agent can resume work without reading the SQLite store.
 *
 * This module is intentionally DB-free (mirrors src/db/designs.ts):
 *   - `sessionToLedgerData(session)` is a pure mapper (takes a Session).
 *   - `writeLedger` / `readLedger` only touch the filesystem.
 * The integrator lives in src/db/sessions.ts (checkpointSession), which
 * keeps the runtime dependency one-way (sessions → ledgers) and avoids
 * import cycles.
 *
 * Safety guarantees:
 *  - sessionId is sanitized to filename-safe chars (path-traversal-safe).
 *  - writes are ATOMIC (temp file + rename) so a crash never leaves a
 *    truncated/partial ledger.
 *  - writes are IDEMPOTENT (same input → same bytes → overwrite); calling
 *    writeLedger repeatedly on a checkpoint refresh is safe.
 *  - missing-ledger reads return `null` (consistent with getSession /
 *    getPlan repo convention — never throw on "not found").
 *
 * Round-trip strategy: the markdown is human-readable (formatted sections)
 * AND embeds a machine-readable JSON block. `parseLedgerFromMarkdown`
 * extracts the JSON block, so round-trips are robust and do not depend on
 * fragile prose parsing.
 *
 * See task: filesystem continuity ledger.
 */

import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Session, SessionOutcome } from "./types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Portable snapshot of a session written to the ledger markdown.
 * A strict subset/shape of {@link Session} — decoupled from the DB row so
 * the file remains stable even if the SQL schema evolves.
 */
export interface LedgerData {
  sessionId: string;
  goal: string;
  planId: string | null;
  state: Record<string, unknown>;
  keyDecisions: string | null;
  agentHistory: Session["agentHistory"];
  startedAt: number;
  lastCheckpoint: number | null;
  endedAt: number | null;
  outcome: SessionOutcome | null;
  metadata: Session["metadata"];
}

/** Metadata returned after a ledger is written. */
export interface LedgerWriteResult {
  sessionId: string;
  /** Absolute path to the written markdown file. */
  filePath: string;
  byteSize: number;
  /** Epoch ms when the ledger was (re)written. */
  updatedAt: number;
  /** `true` if the file did not exist before this write (first creation). */
  created: boolean;
}

// ─── Validation & sanitization (pure) ────────────────────────────────────────

const SESSION_ID_MAX_LENGTH = 128;
/**
 * Filename-safe allowlist for a session id. UUIDs, `ses_xxx`, alnum,
 * underscore, hyphen. Slashes, dots, spaces, and anything escapable are
 * collapsed to `-` to defeat path traversal.
 */
const SESSION_ID_SAFE_RE = /[^a-zA-Z0-9_-]+/g;

/**
 * Sanitize a session id to a filename-safe token.
 *
 * Defeats path traversal: `../etc/passwd` → `etc-passwd`, `a/b` → `a-b`,
 * `..` alone → empty (caught by validateSessionId).
 */
export function sanitizeSessionId(id: string): string {
  return id
    .replace(SESSION_ID_SAFE_RE, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SESSION_ID_MAX_LENGTH);
}

/**
 * Validate a session id for ledger use. Throws on empty / whitespace-only /
 * post-sanitization-empty input. Returns the SANITIZED id (the value that
 * will actually form the filename), mirroring validateDesignSlug.
 */
export function validateSessionId(id: string): string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("ndomo: session id cannot be empty");
  }
  const clean = sanitizeSessionId(id);
  if (clean.length === 0) {
    throw new Error(
      `ndomo: session id '${id}' sanitizes to empty (needs at least one [a-zA-Z0-9_-] char)`,
    );
  }
  return clean;
}

// ─── Data mapping (pure) ─────────────────────────────────────────────────────

/**
 * Map a {@link Session} (DB row) to a portable {@link LedgerData} snapshot.
 * Pure: no I/O. Callers pass the already-loaded session so this module
 * stays DB-free (no getSession dependency → no import cycle).
 */
export function sessionToLedgerData(session: Session): LedgerData {
  return {
    sessionId: session.id,
    goal: session.goal,
    planId: session.planId,
    state: session.state,
    keyDecisions: session.keyDecisions,
    agentHistory: session.agentHistory,
    startedAt: session.startedAt,
    lastCheckpoint: session.lastCheckpoint,
    endedAt: session.endedAt,
    outcome: session.outcome,
    metadata: session.metadata,
  };
}

// ─── Markdown serialization (pure) ───────────────────────────────────────────

/** Sentinel markers wrapping the machine-readable JSON block. */
const DATA_BLOCK_START = "<!-- ndomo:ledger-data -->";
const DATA_BLOCK_END = "<!-- /ndomo:ledger-data -->";

function iso(ts: number | null): string {
  return ts !== null ? new Date(ts).toISOString() : "—";
}

function short(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

/**
 * Serialize a ledger snapshot to a stable, human-readable markdown string.
 * Embeds a machine-readable JSON block (sentinel-delimited) so
 * {@link parseLedgerFromMarkdown} can round-trip without prose parsing.
 * Pure: no I/O.
 *
 * @param data The session snapshot.
 * @param updatedAt Epoch ms of this write (stamped into the doc).
 */
export function serializeLedgerToMarkdown(data: LedgerData, updatedAt: number): string {
  const sections: string[] = [
    `# Session Ledger: ${data.sessionId}`,
    "",
    `**Session ID:** ${data.sessionId}  `,
    `**Goal:** ${data.goal}  `,
    `**Plan:** ${data.planId ?? "—"}  `,
    `**Started:** ${iso(data.startedAt)}  `,
    `**Last Checkpoint:** ${iso(data.lastCheckpoint)}  `,
    `**Ended:** ${iso(data.endedAt)}  `,
    `**Outcome:** ${data.outcome ?? "—"}  `,
    `**Updated:** ${iso(updatedAt)}  `,
  ];

  // State (human-readable JSON)
  sections.push("", "## State", "", "```json", JSON.stringify(data.state, null, 2), "```");

  // Key decisions
  sections.push("", "## Key Decisions", "", data.keyDecisions ?? "— none —");

  // Agent history
  sections.push("", `## Agent History (${data.agentHistory.length})`, "");
  if (data.agentHistory.length === 0) {
    sections.push("— none —");
  } else {
    for (const h of data.agentHistory) {
      const task = h.taskId ? short(h.taskId) : "—";
      const ended = h.endedAt !== null ? new Date(h.endedAt).toISOString() : "ongoing";
      sections.push(
        `- **${h.agent}** — task: ${task}, started ${new Date(h.startedAt).toISOString()}, ended ${ended}`,
      );
    }
  }

  // Machine-readable round-trip block. Sanitize triple backticks inside the
  // JSON (HIGH 6 pattern from plan-archive) so the embedded fence never
  // breaks the outer markdown.
  const dataJson = JSON.stringify(data).replace(/```/g, "\\`\\`\\`");
  sections.push(
    "",
    "## Session Data (machine-readable)",
    "",
    DATA_BLOCK_START,
    "```json",
    dataJson,
    "```",
    DATA_BLOCK_END,
    "",
  );

  return sections.join("\n");
}

/**
 * Parse a ledger markdown string back into {@link LedgerData}.
 *
 * Extracts the sentinel-delimited JSON block. Returns `null` if the block
 * is missing or malformed — never throws on a corrupt/foreign file
 * (consistent with the "missing reads return null" convention).
 *
 * @param md Raw markdown contents of a ledger file.
 */
export function parseLedgerFromMarkdown(md: string): LedgerData | null {
  const startIdx = md.indexOf(DATA_BLOCK_START);
  if (startIdx === -1) return null;
  const endIdx = md.indexOf(DATA_BLOCK_END, startIdx);
  if (endIdx === -1) return null;

  const block = md.slice(startIdx + DATA_BLOCK_START.length, endIdx);
  // Extract the first fenced code block inside the sentinel region.
  const fence = block.indexOf("```");
  if (fence === -1) return null;
  const fenceEnd = block.indexOf("```", fence + 3);
  if (fenceEnd === -1) return null;
  // Skip the opening fence line (```json).
  const afterFence = block.slice(fence + 3);
  const nl = afterFence.indexOf("\n");
  if (nl === -1) return null;
  const jsonText = afterFence.slice(nl + 1, fenceEnd - (fence + 3)).trim();

  try {
    // Reverse the triple-backtick sanitization applied during serialize.
    const restored = jsonText.replace(/\\`\\`\\`/g, "```");
    return JSON.parse(restored) as LedgerData;
  } catch {
    return null;
  }
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

/**
 * Resolve the per-project ledger directory.
 * Path: `<projectDir>/.ndomo/ledgers/`. Creates it if missing.
 */
export function resolveLedgerDir(projectDir: string): string {
  const dir = join(projectDir, ".ndomo", "ledgers");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Compute the absolute ledger path for a session id.
 *
 * Side effect: delegates to {@link resolveLedgerDir}, which creates the
 * `<projectDir>/.ndomo/ledgers/` directory (mkdir -p) if it does not yet
 * exist. So calling this WILL materialize the directory on disk, even when
 * the caller only intends to inspect a path. Use this function when you are
 * about to read/write; for a pure path-only computation (no mkdir), inline a
 * `join(projectDir, ".ndomo", "ledgers", \`${clean}.md\`)` instead.
 *
 * Does NOT validate that the file itself exists (only the directory is
 * ensured). The session id IS validated + sanitized before joining, so
 * traversal inputs are neutralized regardless of caller care.
 */
export function getLedgerFilePath(projectDir: string, sessionId: string): string {
  const clean = validateSessionId(sessionId);
  return join(resolveLedgerDir(projectDir), `${clean}.md`);
}

/**
 * Atomically write `content` to `filePath` via temp-file + rename.
 *
 * `rename(2)` is atomic on POSIX when source and destination share a
 * filesystem (they do — both live in the ledger dir), so a crash mid-write
 * never exposes a partially-written ledger. The temp file is cleaned up on
 * write failure.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup — temp removal failure is non-fatal.
    }
    throw err;
  }
}

/**
 * Write (create or overwrite) a session ledger to the filesystem.
 *
 * Idempotent: the same {@link LedgerData} produces byte-identical output
 * modulo the `updatedAt` stamp, so repeated checkpoint writes are safe.
 * Atomic: never leaves a partial file on crash. Validates + sanitizes the
 * session id for the filename.
 *
 * @param projectDir Absolute path to the project root.
 * @param data Session snapshot to persist.
 * @returns Metadata about the written file, including whether it was newly
 *   created (`created: true`) versus overwritten.
 */
export function writeLedger(projectDir: string, data: LedgerData): LedgerWriteResult {
  const clean = validateSessionId(data.sessionId);
  const dir = resolveLedgerDir(projectDir);
  const filePath = join(dir, `${clean}.md`);
  const existed = existsSync(filePath);

  const updatedAt = Date.now();
  const md = serializeLedgerToMarkdown({ ...data, sessionId: clean }, updatedAt);

  atomicWriteFileSync(filePath, md);

  return {
    sessionId: clean,
    filePath,
    byteSize: Buffer.byteLength(md, "utf-8"),
    updatedAt,
    created: !existed,
  };
}

/**
 * Read a session ledger from the filesystem and parse it.
 *
 * Returns the parsed {@link LedgerData}, or `null` if the file is missing
 * or unparseable. Never throws on a missing/corrupt ledger (consistent
 * with getSession/getPlan "not found → null" convention).
 *
 * @param projectDir Absolute path to the project root.
 * @param sessionId Session id (validated + sanitized for the filename).
 */
export function readLedger(projectDir: string, sessionId: string): LedgerData | null {
  const filePath = getLedgerFilePath(projectDir, sessionId);
  if (!existsSync(filePath)) return null;
  const md = readFileSync(filePath, "utf-8");
  return parseLedgerFromMarkdown(md);
}

/**
 * Read the raw markdown of a session ledger, unmodified.
 *
 * Returns `null` when the file is missing (matches {@link readLedger}).
 * Useful when the caller wants the human-readable doc verbatim rather than
 * the parsed struct.
 *
 * @param projectDir Absolute path to the project root.
 * @param sessionId Session id (validated + sanitized for the filename).
 */
export function readLedgerRaw(projectDir: string, sessionId: string): string | null {
  const filePath = getLedgerFilePath(projectDir, sessionId);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

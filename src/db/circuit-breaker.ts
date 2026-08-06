/**
 * ndomo — Circuit breaker for tool-call loops.
 *
 * Pure module: NO database imports, NO I/O side effects. Owns only in-memory
 * per-session counters, threshold evaluation, and canonical arg serialization.
 *
 * Detects two loop pathologies that an autonomous agent can fall into:
 *   1. Runaway total call volume per session (default 4000 calls).
 *   2. Repeated IDENTICAL calls — same tool + canonical args back-to-back
 *      (default 20 consecutive) — the strongest loop signal.
 *
 * The breaker trips exactly ONCE per session (one-shot edge). The wiring in
 * `src/plugin.ts` emits the warning + marks the relevant task failed + throws
 * on that single crossing call; every subsequent call in the tripped session
 * is blocked silently (no re-warn, no re-fail) so logs stay clean.
 *
 * Keeping this module pure means the counting/canonicalization/task-id
 * resolution logic is unit-testable without instantiating the OpenCode plugin
 * runtime or opening a database.
 */

/**
 * Default per-session total-call threshold. Crossing it implies an agent is
 * stuck emitting tool calls without converging.
 */
export const DEFAULT_TOTAL_THRESHOLD = 4000;

/**
 * Default consecutive-identical-call threshold. Crossing it implies an agent
 * is repeating the exact same call in a tight loop.
 */
export const DEFAULT_IDENTICAL_THRESHOLD = 20;

/**
 * Exact, stable error message the breaker throws (and writes to failed tasks).
 * Callers must match on this exact string.
 */
export const CIRCUIT_BREAKER_ERROR = "Circuit breaker: potential loop detected";

export interface CircuitBreakerConfig {
  /**
   * Total calls per session before the breaker trips.
   * Defaults to {@link DEFAULT_TOTAL_THRESHOLD} when omitted.
   */
  totalThreshold?: number;
  /**
   * Consecutive identical calls (same tool + canonical args) before the
   * breaker trips. Defaults to {@link DEFAULT_IDENTICAL_THRESHOLD} when
   * omitted.
   */
  identicalThreshold?: number;
}

/** Which threshold was crossed on the tripping call. */
export type TripReason = "total" | "identical";

interface SessionState {
  callCount: number;
  lastTool: string | null;
  lastArgsHash: string | null;
  identicalCount: number;
  tripped: boolean;
}

/** Result of a single {@link CircuitBreaker.check} call. */
export interface CircuitBreakerCheckResult {
  /** True when this call is blocked (threshold crossed now OR session already tripped). */
  blocked: boolean;
  /** Set only on the edge call that crosses a threshold; null otherwise (incl. silent re-blocks). */
  reason: TripReason | null;
  /** Total calls recorded for this session AFTER recording this one. */
  callCount: number;
  /** Current consecutive-identical streak AFTER recording this one. */
  identicalCount: number;
  /** True ONLY on the single call that flips the session from healthy → tripped. */
  trippedNow: boolean;
}

/**
 * Deterministically canonicalize tool-call args into a stable string so that
 * two calls with logically-equal args (but different key insertion order or
 * edge-case value types) hash identically.
 *
 * Guarantees:
 *  - Object keys sorted alphabetically → insertion-order independent.
 *  - Circular references → `"[Circular]"` marker (WeakSet guards recursion).
 *  - `undefined` → `"[Undefined]"` (JSON.stringify drops it; we preserve it).
 *  - `bigint` → `"[BigInt:n]"`, `NaN`/`±Infinity` → `"[Number:...]"`.
 *  - `function` → `"[Function]"`, `symbol` → `"[Symbol:...]"`.
 *  - Never throws: falls back to `String(args)` if normalization blows up.
 *
 * @example
 *   canonicalizeArgs({ b: 2, a: 1 }) === canonicalizeArgs({ a: 1, b: 2 }) // true
 */
export function canonicalizeArgs(args: unknown): string {
  const seen = new WeakSet<object>();

  const normalize = (val: unknown): unknown => {
    if (val === undefined) return "[Undefined]";
    if (val === null) return null;
    const t = typeof val;
    if (t === "string" || t === "boolean") return val;
    if (t === "number") return Number.isFinite(val) ? val : `[Number:${String(val)}]`;
    if (t === "bigint") return `[BigInt:${(val as bigint).toString()}]`;
    if (t === "function") return "[Function]";
    if (t === "symbol") return `[Symbol:${(val as symbol).toString()}]`;
    if (t !== "object") return String(val);

    // Object (incl. arrays). Circular-reference guard via WeakSet.
    const obj = val as object;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);

    if (Array.isArray(val)) {
      return val.map((item) => normalize(item));
    }
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val).sort()) {
      sorted[k] = normalize((val as Record<string, unknown>)[k]);
    }
    return sorted;
  };

  try {
    return JSON.stringify(normalize(args));
  } catch {
    // Pathological input (e.g. a getter that throws) — degrade gracefully.
    return String(args);
  }
}

/**
 * Decide whether the circuit-breaker-tripping call should also mark a task
 * failed, and if so return that task's id.
 *
 * Rules (defensive — we must NEVER accidentally fail an arbitrary resource id):
 *  - Only consider tools in the `task_*` family. `plan_get(id=...)`,
 *    `analysis_get(id=...)`, `session_end(id=...)` etc. carry non-task ids and
 *    are ignored entirely.
 *  - Accept `taskId` or `id` keys, non-empty string values only.
 *  - NEVER return the id referenced by a `task_update_status` call itself —
 *    marking that task failed would recurse into the very status machinery the
 *    caller was exercising and clobber their intent. The breaker still blocks
 *    the call; it just skips the DB side effect.
 *
 * @returns the task id to fail, or `null` when there is no safe target.
 */
export function resolveCircuitBreakerTaskFailure(toolName: string, args: unknown): string | null {
  if (typeof toolName !== "string" || !toolName.startsWith("task_")) return null;
  // task_update_status target is exempt: failing it would recurse / be
  // semantically wrong (the caller was already manipulating its status).
  if (toolName === "task_update_status") return null;
  if (args == null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  const candidate = record.taskId ?? record.id;
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null;
  return candidate;
}

/**
 * Per-session tool-call loop detector.
 *
 * Instantiate once (the plugin holds a single instance in its closure). Each
 * tool call flows through {@link CircuitBreaker.check}; the wiring decides
 * what to do with the result (warn / fail task / throw).
 *
 * The session namespace is keyed by the OpenCode `sessionID`. Counters are
 * fully isolated across sessions — a trip in one never affects another.
 */
export class CircuitBreaker {
  private readonly sessions = new Map<string, SessionState>();
  private readonly totalThreshold: number;
  private readonly identicalThreshold: number;

  constructor(config: CircuitBreakerConfig = {}) {
    // Coerce to finite positive integers (≥ 1); fall back to defaults on any
    // malformed input so a bad config value can never disable protection.
    // Covers: undefined, NaN, ±Infinity, 0, negatives, AND sub-1 fractions
    // (0.1→floor=0 would trip on call #1). See `toSafeThreshold` for details.
    this.totalThreshold = toSafeThreshold(config.totalThreshold, DEFAULT_TOTAL_THRESHOLD);
    this.identicalThreshold = toSafeThreshold(
      config.identicalThreshold,
      DEFAULT_IDENTICAL_THRESHOLD,
    );
  }

  /** Frozen view of the effective thresholds (diagnostics/testing). */
  get config(): Readonly<{ totalThreshold: number; identicalThreshold: number }> {
    return Object.freeze({
      totalThreshold: this.totalThreshold,
      identicalThreshold: this.identicalThreshold,
    });
  }

  /**
   * Record a tool call for `sessionId` and evaluate thresholds.
   *
   * Always increments `callCount`. Updates the consecutive-identical streak
   * against the previous call (resets to 1 when the tool name OR canonical
   * args differ). On the FIRST threshold crossing for the session, flips
   * `tripped` on and returns `trippedNow: true` with a `reason`. After the
   * session has tripped, further calls return `blocked: true` with
   * `trippedNow: false` and `reason: null` (silent one-shot re-block).
   */
  check(sessionId: string, toolName: string, args: unknown): CircuitBreakerCheckResult {
    const sid = sessionId || "__no_session__";
    let state = this.sessions.get(sid);
    if (!state) {
      state = {
        callCount: 0,
        lastTool: null,
        lastArgsHash: null,
        identicalCount: 0,
        tripped: false,
      };
      this.sessions.set(sid, state);
    }

    // Session already tripped → block silently (no re-warn / re-fail).
    if (state.tripped) {
      state.callCount += 1;
      return {
        blocked: true,
        reason: null,
        callCount: state.callCount,
        identicalCount: state.identicalCount,
        trippedNow: false,
      };
    }

    state.callCount += 1;
    const argsHash = canonicalizeArgs(args);
    const sameAsLast = state.lastTool === toolName && state.lastArgsHash === argsHash;
    state.identicalCount = sameAsLast ? state.identicalCount + 1 : 1;
    state.lastTool = toolName;
    state.lastArgsHash = argsHash;

    const crossedTotal = state.callCount >= this.totalThreshold;
    const crossedIdentical = state.identicalCount >= this.identicalThreshold;
    if (crossedTotal || crossedIdentical) {
      state.tripped = true;
      // Prefer the more specific 'identical' signal when both cross together.
      const reason: TripReason = crossedIdentical ? "identical" : "total";
      return {
        blocked: true,
        reason,
        callCount: state.callCount,
        identicalCount: state.identicalCount,
        trippedNow: true,
      };
    }

    return {
      blocked: false,
      reason: null,
      callCount: state.callCount,
      identicalCount: state.identicalCount,
      trippedNow: false,
    };
  }

  /** Reset (forget) a session's counters — testing and manual recovery. */
  reset(sessionId: string): void {
    this.sessions.delete(sessionId || "__no_session__");
  }

  /** Read-only snapshot of a session's counters (diagnostics/testing). */
  snapshot(sessionId: string): Readonly<SessionState> | undefined {
    const sid = sessionId || "__no_session__";
    const s = this.sessions.get(sid);
    return s ? { ...s } : undefined;
  }
}

/**
 * Coerce a user-supplied threshold into a safe finite positive integer.
 * Falls back to `fallback` for undefined / non-finite / non-positive values so
 * a corrupt config entry can never disable the breaker (threshold ≤ 0 would
 * trip on the first call and threshold NaN/Infinity would never trip).
 *
 * Crucially, sub-1 positive fractions (0.1, 0.9, …) also fall back: their
 * `Math.floor` is 0, which would trip the breaker on the very first call and
 * invert the safety guarantee. Floor BEFORE the positivity check, never after.
 */
function toSafeThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  // `floored < 1` covers 0, negatives (after floor), AND sub-1 fractions
  // (0.1→0, 0.9→0) that would otherwise disable protection by tripping on
  // call #1. Contract is "positive integer ≥ 1"; anything else → fallback.
  return floored >= 1 ? floored : fallback;
}

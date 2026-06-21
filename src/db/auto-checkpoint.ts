/**
 * ndomo DB — Auto-checkpoint dispatcher.
 *
 * Captures orchestrator state into session checkpoints on configurable
 * triggers (phase_transition, task_batch_complete). Debounced, async,
 * loop-safe.
 */

import type { Database } from "bun:sqlite"
import { getPlan } from "./plans.ts"
import { checkpointSession, ensureSession } from "./sessions.ts"
import { listTasksByPlan } from "./tasks.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AutoCheckpointConfig {
  enabled?: boolean
  triggers?: string[]
  minIntervalMs?: number
  captureState?: {
    completedTasks?: boolean
    currentPhase?: boolean
    blockers?: boolean
  }
}

export interface AutoCheckpointContext {
  planId?: string
  sessionId?: string
  blockers?: string[] | undefined
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_ENABLED = true
const DEFAULT_TRIGGERS = ["phase_transition", "task_batch_complete"]
const DEFAULT_MIN_INTERVAL_MS = 30_000
const DEFAULT_CAPTURE_COMPLETED = true
const DEFAULT_CAPTURE_PHASE = true
const DEFAULT_CAPTURE_BLOCKERS = true

// ─── Dispatcher ─────────────────────────────────────────────────────────────

/**
 * Async, debounced checkpoint dispatcher.
 *
 * Instantiate with a Database + optional config. Call `dispatch()` from
 * tool executors after a successful state mutation. The actual
 * `checkpointSession` call runs in a microtask (non-blocking) with
 * error swallowing so it never breaks the caller.
 *
 * Loop prevention: an `isAutoCheckpointing` flag prevents re-entrant
 * dispatch. Since `checkpointSession` only writes to the sessions
 * table (not plans/tasks), loops are structurally impossible — but the
 * flag is a safety net.
 */
export class AutoCheckpointDispatcher {
  private lastCheckpointAt = 0
  private isAutoCheckpointing = false

  private readonly enabled: boolean
  private readonly triggers: Set<string>
  private readonly minIntervalMs: number
  private readonly captureCompleted: boolean
  private readonly capturePhase: boolean
  private readonly captureBlockers: boolean
  private readonly db: Database

  constructor(db: Database, config?: AutoCheckpointConfig) {
    this.db = db
    this.enabled = config?.enabled ?? DEFAULT_ENABLED
    this.triggers = new Set(config?.triggers ?? DEFAULT_TRIGGERS)
    this.minIntervalMs = config?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.captureCompleted = config?.captureState?.completedTasks ?? DEFAULT_CAPTURE_COMPLETED
    this.capturePhase = config?.captureState?.currentPhase ?? DEFAULT_CAPTURE_PHASE
    this.captureBlockers = config?.captureState?.blockers ?? DEFAULT_CAPTURE_BLOCKERS
  }

  /**
   * Fire an auto-checkpoint if conditions are met.
   *
   * Checks (in order): loop guard → enabled → trigger allowed → debounce → sessionId present.
   * If all pass, schedules async checkpoint via microtask.
   */
  dispatch(trigger: string, ctx: AutoCheckpointContext): void {
    if (this.isAutoCheckpointing) return
    if (!this.enabled) return
    if (!this.triggers.has(trigger)) return

    const now = Date.now()
    if (now - this.lastCheckpointAt < this.minIntervalMs) return
    if (!ctx.sessionId) return

    this.lastCheckpointAt = now
    this.isAutoCheckpointing = true

    // Async dispatch — does NOT block the caller
    Promise.resolve().then(() => {
      try {
        ensureSession(this.db, ctx.sessionId!, "auto-checkpoint")

        const state: Record<string, unknown> = { trigger }

        if (ctx.planId) {
          if (this.captureCompleted) {
            const doneTasks = listTasksByPlan(this.db, ctx.planId, { status: "done" })
            state.completedTasks = doneTasks.length
          }
          if (this.capturePhase) {
            const plan = getPlan(this.db, ctx.planId)
            state.currentPhase = plan?.status ?? "unknown"
          }
        }

        if (this.captureBlockers && ctx.blockers && ctx.blockers.length > 0) {
          state.blockers = ctx.blockers
        }

        checkpointSession(this.db, ctx.sessionId!, state)
      } catch (err) {
        // Auto-checkpoint must never break the caller
        console.error(
          "[ndomo] auto_checkpoint failed:",
          err instanceof Error ? err.message : String(err),
        )
      } finally {
        this.isAutoCheckpointing = false
      }
    })
  }
}

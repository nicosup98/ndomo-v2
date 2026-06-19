# Workflow Guide

## Standard Workflow

The default execution flow for any user request:

```
User Request → Foreman → Memory Search → Routing → Dispatch → [Specialists] → Reconcile → Inspector → Report
```

1. **Foreman receives request** — analyzes intent in 1-2 sentences. If ambiguous, asks clarifying questions.
2. **Memory search** — searches opencode-mem for relevant past decisions before planning.
3. **Routing** — selects agent(s) based on task type, stack, and risk level (see scheduler priority in `src/orchestrator/scheduler.ts`).
4. **Atomic plan** — breaks work into numbered steps. Each step: `(Action) → [Delegate: <agent> | Trivium-self]`.
5. **Dispatch** — launches agents as background tasks with unique task IDs. Tracks session IDs, target files, and status.
6. **Parallelization** — independent tasks run in parallel; dependent tasks queue sequentially.
7. **Reconciliation** — integrates outputs from multiple agents, detects file conflicts.
8. **Validation** — foreman invokes `inspector` on the resulting diff.
9. **Final report** — presented in caveman format with objective, routing decisions, task statuses, and notes.

## Deepwork

**When to use:** Multi-file refactors (> 5 files), risky architecture changes (database schema, auth flow, API contracts), phased features with inter-step dependencies, cross-stack work.

Use `deepwork <task description>` to invoke. The workflow:

1. **Plan creation** — foreman creates `.slim/deepwork/<slug>.md` with phases, expected files, dependencies, and risk levels.
2. **Phase breakdown** — each phase is a discrete step with clear entry/exit criteria.
3. **Sage gates** — after each phase, `sage` reviews the result. If the gate fails, the plan is adjusted before proceeding.
4. **Worktree isolation** — deepwork auto-creates a git worktree at `.slim/worktrees/<slug>/` for isolation.
5. **Progress tracking** — the plan file is updated after each phase. Work can be resumed after context loss.
6. **Completion** — after all phases pass sage gates, the foreman requests user confirmation before merging the worktree.

## Worktrees

**When to use:** Risky changes that might break the main working tree, parallel development, experimental features, deepwork sessions.

Created by the foreman or on explicit request: "create a worktree for <task>".

### Lifecycle

```
Create → Work in isolation → User confirms merge → Merge → Cleanup
```

1. **Create** — `createWorktree(rootDir, slug, branch, agent?, description?)` creates a git worktree at `.slim/worktrees/<slug>/`.
2. **Isolate** — specialists are dispatched inside the worktree for file isolation.
3. **Track state** — persists state in `.slim/worktrees.json` via `loadState()` / `saveState()`.
4. **Integrity** — `verifyIntegrity()` checks directory existence, branch validity, and git registration.
5. **Merge** — user confirms explicitly before merging to main.
6. **Cleanup** — `cleanup()` removes abandoned/merged worktrees older than maxAge (default 7 days).

### Safety protocols

- `assertSafeName()` prevents shell injection in slug/branch parameters (alphanumeric, hyphens, underscores, slashes only; no leading hyphen).
- Foreman requires explicit user confirmation before merging any worktree.
- Integrity checks run on all active worktrees.

## Reflect

**When to use:** After 3+ similar tasks, repeated friction in workflows, or on user request.

Invoke: `reflect [optional focus]`

The workflow:

1. **Search memory** — scribe searches recent work for friction patterns and repeated errors.
2. **Analyze** — identify the root cause of repetitive friction.
3. **Propose fix** — suggest the smallest useful change: a new skill, command, agent, or config rule.
4. **Implement** — with user approval, create the fix.

Not for: one-off tasks or well-understood patterns with no friction.

## Background Dispatch

The `BackgroundDispatcher` class (`src/orchestrator/background.ts`) provides pure state tracking:

1. **dispatch** — registers a new task (`pending` status), returns a task ID.
2. **markRunning** — transitions to `running` with a session ID and timestamp.
3. **getActive** — returns all pending or running tasks.
4. **markComplete / markFailed** — transitions to terminal state with result or error.
5. **reconcile** — collects all finished tasks for processing.
6. **remove** — cleans up after reconciliation.

### No write overlap rule

Two agents editing the same file simultaneously is forbidden. Before dispatching a writer, the foreman checks that no active task claims those files. This is enforced at the scheduling level — the `canRunParallel()` function checks for file conflicts and dependency chains.

### Parallel dispatch rules

- Tasks with no explicit file list are assumed non-conflicting.
- Tasks with `parallel: false` (guild, sage debug) block the batch.
- If task A depends on task B (via `dependencies`), they cannot run in parallel.

## Memory Integration

The foreman runs the following memory protocol on every request:

1. **Before planning** — `memory({mode:"search", scope:"project"})` for current project context; `memory({mode:"search", scope:"all-projects"})` for cross-project knowledge.
2. **Before storing** — compress content to caveman format using `cavemanCompress()`.
3. **Compression rules** — drops articles, filler words, leading conjunctions, filler phrases. Preserves code blocks and URLs.
4. **Threshold** — `shouldStoreMemory()` filters out content < 20 chars or purely code blocks.
5. **Protected** — memory tool outputs are never pruned from context (listed in `protectedTools`).

The `memory-hook.ts` module provides `cavemanCompress()`, `prepareForMemory()`, and `shouldStoreMemory()` — all regex-based (zero LLM tokens).

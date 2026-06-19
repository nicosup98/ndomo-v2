# Agent Reference

## Overview

ndomo defines 15 agents grouped by function. All agent definitions live as Markdown files in `agents/` with YAML frontmatter specifying model, temperature, permissions, and mode.

## Orchestrator

### foreman

The master orchestrator. Only agent with `mode: primary`. Delegates all substantive work to subagents. Never writes business logic directly.

- **Model:** minimax/MiniMax-M3 (default), deepseek-v4-flash (budget)
- **Temperature:** 0.3
- **Permissions:** edit (ask), write (ask), bash (ask), question (allow)
- **Delegates to:** all 14 subagents
- **File:** `agents/foreman.md`

Rules:
1. Trivium threshold — direct edits only for <= 5 lines, 1 file, no new functions/exports, no behavior changes
2. Always searches memory before planning
3. Monitors context size and triggers DCP compression near limits
4. Background dispatch with task ID tracking, parallel when no file conflicts
5. Always reconciles results before reporting

## Explorers

Read-only agents for investigation and research.

### scout

Codebase reconnaissance. Navigates repositories at maximum speed: maps structures, locates symbols, finds patterns, traces dependencies.

- **Model:** opencode-go/minimax-m2.7
- **Temperature:** 0.3
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/scout.md`
- **Use when:** "find where X is defined", "map the auth flow", "what calls this function"

### scribe

External knowledge retrieval. Searches documentation, APIs, libraries, and web resources. Does not modify code.

- **Model:** opencode-go/minimax-m2.7
- **Temperature:** 0.3
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/scribe.md`
- **Use when:** "research best practices for X", "find docs for this library", "what version of Y should we use"

## Builders

Write code. Divided into generic smith and stack-specific smiths.

### painter

UI/UX designer. Handles visual composition, component design, and frontend styling. Triggered only when `stack === "vue"` and `type === "design"`.

- **Model:** opencode-go/kimi-k2.6
- **Temperature:** 0.2
- **Permissions:** edit (allow), write (allow), bash (allow), question (allow)
- **File:** `agents/painter.md`
- **Use when:** "design a login page", "create a dashboard layout", "style this component"

### smith

Generic fast implementation specialist. Stack-agnostic — handles well-defined tasks in any language. Default fallback for unknown stacks.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow), question (allow)
- **File:** `agents/smith.md`
- **Use when:** small fixes, config changes, simple features, mechanical refactors in any language

### go-smith

Go implementation specialist. Idiomatic Go patterns, testing with table-driven tests, concurrency, error handling.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/go-smith.md`

### js-smith

JavaScript/TypeScript implementation specialist. Frontend and backend JS/TS, modern patterns, typing.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/js-smith.md`

### python-smith

Python implementation specialist. Pythonic idioms, type hints, testing with pytest.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/python-smith.md`

### vue-smith

Vue 3 / Pinia implementation specialist. Composition API, `<script setup>`, Vue Router, Pinia stores.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/vue-smith.md`

### zig-smith

Zig 0.16 implementation specialist. Systems programming, Zig idioms, memory management.

- **Model:** xiaomi/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/zig-smith.md`

### rust-smith

Rust implementation specialist. Ownership, lifetimes, traits, async/Tokio, zero-cost abstractions, compile-time SQL checks.

- **Model:** opencode-go/mimo-v2.5-pro
- **Temperature:** 0.1
- **Permissions:** edit (allow), write (allow), bash (allow)
- **File:** `agents/rust-smith.md`
- **Skills:** `rust-patterns`, `rust-testing`

## Advisors

Provide analysis, guidance, and multi-perspective evaluation. Read-only (edit denied).

### sage

Architecture advisor and high-risk debugger. Deep reasoning for complex problems, trade-off analysis, architecture decisions.

- **Model:** opencode-go/deepseek-v4-pro
- **Temperature:** 0.2
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/sage.md`
- **Use when:** "review this architecture", "debug this complex issue", "what's the best approach for X"
- **Manual call:** `sage <question>`
- **Auto-triggered:** when `type === "debug" && risk === "high"`, or `high risk implement` (as advisory parallel to the stack-smith)

### guild

Multi-LLM consensus and architectural debate. Simulates multiple perspectives to reach consensus on high-risk decisions.

- **Model:** opencode-go/deepseek-v4-pro
- **Temperature:** 0.3
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/guild.md`
- **Use when:** "should we use X or Y architecture", "is this design safe"
- **Note:** Manual delegation only — never auto-routed by the scheduler. The foreman only delegates to guild on explicit user request (`type: "debate"`).

## Quality

Review and documentation agents. Invoked after implementation phases.

### inspector

Code quality and security auditor. Reviews diffs for bugs, anti-patterns, security issues, and style violations.

- **Model:** opencode-go/deepseek-v4-pro
- **Temperature:** 0.2
- **Permissions:** edit (deny), bash (allow), question (allow)
- **File:** `agents/inspector.md`
- **Use when:** "review this diff", "audit this PR", "check for security issues"
- **Auto-triggered:** foreman invokes inspector on the resulting diff before closing any task

### chronicler

Technical documentation writer. Analyzes code and generates Markdown documentation. Read-only on existing code; writes documentation files.

- **Model:** opencode-go/deepseek-v4-flash
- **Temperature:** 0.2
- **Permissions:** edit (allow), write (allow), bash (deny)
- **File:** `agents/chronicler.md`
- **Use when:** "document this API", "generate README", "write migration guide"

## Routing Table

The scheduler (`src/orchestrator/scheduler.ts`) applies this priority order:

```
1. explore         → scout
2. research        → scribe
3. design + vue    → painter
4. audit           → inspector
5. document        → chronicler
6. debate          → guild (manual only)
7. debug + high    → sage
8. implement + known stack → stack-smith
9. implement + generic     → smith
10. high risk implement → stack-smith + sage advisory
11. default fallback → smith
```

Tasks with `high` risk and `implement` type return a dependency on `sage-review` — the stack-smith runs in parallel but the foreman must run sage review before merge.

## Custom Agents

See [configuration.md](configuration.md#custom-agents) for instructions on adding new specialist agents to the routing table.

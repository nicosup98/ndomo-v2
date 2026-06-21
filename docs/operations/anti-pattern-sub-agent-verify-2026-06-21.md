# Anti-pattern: Sub-agents marking plans done without DB verification

**Date:** 2026-06-21  
**Plan context:** a7e75f8b (foreman-verify-protocol-v1)  
**Severity:** process — schema drift / audit gaps

## Incidents

### 1. ops-audit-v2
A sub-agent closed the plan as `completed` after reporting audit findings, but never ran an objective verification pass against the DB state. The completion status became self-certified rather than evidence-based.

- **Root cause:** no explicit verify step before `plan_update_status("completed")`.
- **Impact:** plan marked done while DB consistency checks were unverified; audit trail gap.

### 2. craftsman-db-optimize-v1
Migration v12 was not auto-applied in the execution environment, yet the plan was marked `completed`. This is the second occurrence of a schema migration being skipped while the plan status advanced.

- **Root cause:** craftsman trusted implementation-side success (tests green, code merged) without checking `PRAGMA user_version`.
- **Impact:** schema drift between code expectations and runtime DB; runtime queries could hit missing views/indexes.

## Pattern

Both cases share the same failure mode: the executing sub-agent acted as both implementer and certifier. It assumed "I wrote it / tests passed" meant "system state matches intent," bypassing objective verification of the actual DB and runtime artifacts.

This is a governance anti-pattern: the agent that performs the work cannot also be the sole authority that declares the work correct. Objective verification must come from an independent check of the produced state.

## Mitigation

- Enforce the **foreman verify protocol** (see `agents/foreman.md`): no plan moves to `completed` until verify checks are recorded.
- Add a **gate agent** (inspector) as an independent post-plan verification step; see `verify-gate-architecture.md`.
- Craftsman must not self-certify completion; gate verdict is binary and write-once.
- For DB-touching plans, require `PRAGMA user_version` and a smoke query against the changed schema as gate checks.

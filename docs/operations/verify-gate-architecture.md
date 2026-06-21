# Verify Gate Architecture

Post-plan verification gate for the multi-agent workflow. Prevents implementer self-certification by requiring an independent agent to confirm objective state before a plan is marked `completed`.

## 1. Problem statement

Two recent incidents show the same failure mode:

| Incident | Plan | What happened |
|----------|------|---------------|
| Audit gap | `ops-audit-v2` | Sub-agent marked plan `completed` without verifying DB state. |
| Schema drift | `craftsman-db-optimize-v1` | v12 migration was not auto-applied, yet plan was marked `completed`; second occurrence of this class. |

In both cases the implementer acted as certifier. The system needs an independent verification gate that checks objective artifacts (git diff, DB state, tests) before `plan_update_status("completed")` is allowed.

## 2. Candidate gate agents

| Agent | Pros as gate owner | Cons as gate owner |
|-------|-------------------|-------------------|
| **inspector** | Specialized in audit, security, diff review; read-only by design; zero conflict of interest. | May lack full DB context for some plans. |
| **sage** | Strong architecture lens; good at catching design-level regressions. | Advisory role, not a binary gate; no mandate to block. |
| **craftsman** | Knows implementation details; can re-run tests quickly. | Conflict of interest — cannot self-certify its own work. |

## 3. Recommendation

- **Gate owner:** `inspector`. It is the only agent whose charter is independent audit and binary approval/rejection. `craftsman` must not own the gate because it implements the work. `sage` remains advisory and can be consulted, but does not hold the gate.
- **Invocation timing:** **post-plan**, not post-each-task. Post-each-task adds too much latency and duplicates the foreman verify protocol, which already covers per-task progress. The gate runs once, after all tasks report `done`, immediately before `plan_update_status("completed")`.
- **Success criteria:** binary `pass` / `fail`. `pass` = every verify-protocol check is green. `fail` = any check is red, with a concrete reason.
- **Integration with status tools:**
  - The gate verdict is recorded in the plan as `metadata.gate = "pass"` or `metadata.gate = "fail: <reason>"`.
  - On `pass`, the foreman calls `plan_update_status("completed")`.
  - On `fail`, the foreman calls `plan_update_status("failed")` and dispatches a remediation task.

## 4. Implementation outline

1. After all tasks are `done`, the foreman gathers the verification package:
   - `git diff` of the change set.
   - Plan metadata, including `expected_schema_version` for DB-touching plans.
   - Test / smoke output.
2. The foreman dispatches `inspector` in read-only mode with the package.
3. Inspector runs a standardized checklist:
   - `bun run typecheck`
   - `bun test`
   - smoke suite
   - `PRAGMA user_version` (for DB plans)
   - `git diff --stat` vs expected files
4. Inspector returns a structured verdict:
   ```json
   {
     "gate": "pass" | "fail",
     "checks": [
       {"name": "typecheck", "status": "pass"},
       {"name": "user_version", "status": "fail", "expected": 12, "actual": 11}
     ],
     "reason": "..."
   }
   ```
5. Foreman applies the verdict and records it in plan metadata.

## 5. Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Extra latency per plan | medium | Post-plan gate is one round-trip; acceptable vs. post-each-task. |
| False positive on flaky test | medium | Allow retry-once for known-flaky checks; document flakes. |
| Inspector becomes bottleneck | low | Gate is read-only and fast; can be parallelized across plans. |
| Inspector lacks DB context | medium | Include `expected_schema_version` and a smoke query in every DB plan dispatch. |

## 6. Open questions

1. **Mandatory vs. optional gate?**
   - Recommendation: mandatory for any plan that touches the DB or public interfaces; optional for pure documentation changes.
2. **Immutable verdict?**
   - Recommendation: yes, write-once. A failed gate requires a new plan or task rather than overwriting the verdict.
3. **Gate for craftsman-owned plans?**
   - Recommendation: yes, especially for craftsman-owned plans, because those are the ones most prone to self-certification.

## Related

- `agents/foreman.md` — verify protocol and plan lifecycle.
- `agents/inspector.md` — gate agent charter.
- `docs/operations/anti-pattern-sub-agent-verify-2026-06-21.md` — incident history.

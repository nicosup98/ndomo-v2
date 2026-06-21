#!/usr/bin/env bun
/**
 * ndomo smoke tests — validates primary flows post-refactor.
 * Run: bun run src/cli/smoke.ts
 * Exit 0 = all pass, exit 1 = any fail.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../db/client.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`[smoke] ${name}: OK`);
    passed++;
  } else {
    console.error(`[smoke] ${name}: FAIL${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function readFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

// ── Smoke A: Foreman flow 4 pasos ──────────────────────────────────────────

const foremanPath = "agents/foreman.md";
check("foreman.md exists", existsSync(join(REPO_ROOT, foremanPath)));

const foreman = existsSync(join(REPO_ROOT, foremanPath)) ? readFile(foremanPath) : "";

check(
  "foreman 4 pasos",
  foreman.includes("Aclaración") &&
    foreman.includes("Exploración") &&
    foreman.includes("Plan Atómico") &&
    foreman.includes("Persistir"),
);

check("foreman delega craftsman", foreman.includes("craftsman"));

// Verify routing table positive delegates are only scout/scribe/sage/guild — NOT smiths/painter/chronicler/inspector
const routingSection = foreman.split("## 🗺️ Tabla de Routing")[1]?.split("##")[0] ?? "";
const tableRows = routingSection.split("\n").filter((l) => l.startsWith("|") && l.includes("`"));
const badDelegates = tableRows.filter(
  (l) => /`smith`|`painter`|`chronicler`|`inspector`/.test(l) && !l.includes("NO delegar"),
);
check("foreman no direct smiths", badDelegates.length === 0);

// ── Smoke B: Craftsman Estado 1 (trivial, ≤2 archivos) ─────────────────────

const craftsmanPath = "agents/craftsman.md";
check("craftsman.md exists", existsSync(join(REPO_ROOT, craftsmanPath)));

const craftsman = existsSync(join(REPO_ROOT, craftsmanPath)) ? readFile(craftsmanPath) : "";

check("craftsman primary mode", craftsman.includes("mode: primary"));

check(
  "craftsman Estado 1 ≤2 archivos",
  craftsman.includes("Estado 1") && craftsman.includes("≤2 archivos"),
);

check(
  "craftsman Estado 1 no plan_db",
  craftsman.includes("NO crea `plan_create`") ||
    craftsman.includes("NO crea plan_create") ||
    craftsman.includes("Cero writes a DB"),
);

// ── Smoke C: Craftsman Estado 3 (plan formal) ──────────────────────────────

check(
  "craftsman Estado 3 plan_get",
  craftsman.includes("Estado 3") &&
    (craftsman.includes("plan_get") || craftsman.includes("task_next_for_agent")),
);

check(
  "craftsman Estado 3 lee plan_db",
  craftsman.includes("lee plan_data") ||
    craftsman.includes("Lee plan_data") ||
    craftsman.includes("lee plan_db") ||
    craftsman.includes("reading existing plan"),
);

// ── Smoke D: Craftsman Estado 4 (rechazo >5 archivos) ──────────────────────

check(
  "craftsman Estado 4 fuera dominio",
  craftsman.includes("FUERA DE MI DOMINIO") || craftsman.includes("fuera de mi dominio"),
);

check(
  "craftsman Estado 4 >5 archivos",
  craftsman.includes(">5 archivos") || craftsman.includes("> 5 archivos"),
);

// ── Smoke E: DB migrations ─────────────────────────────────────────────────

const schemaPath = "src/db/schema.ts";
check("schema.ts exists", existsSync(join(REPO_ROOT, schemaPath)));

const schema = existsSync(join(REPO_ROOT, schemaPath)) ? readFile(schemaPath) : "";
check("schema has migrations", schema.includes("MIGRATIONS") && schema.includes("SCHEMA_V1_SQL"));

// PRAGMA foreign_keys test via bun:sqlite
const tmpDir = mkdtempSync(join(tmpdir(), "ndomo-smoke-"));
const tmpDb = openDb(tmpDir);
const fkResult = tmpDb.query("PRAGMA foreign_keys").get() as Record<string, unknown> | null;
check("PRAGMA foreign_keys = 1", fkResult !== null && fkResult.foreign_keys === 1);
closeDb(tmpDb);

// plan_delete safety: confirm guard
const plansSrc = existsSync(join(REPO_ROOT, "src/db/plans.ts")) ? readFile("src/db/plans.ts") : "";
check(
  "plan_delete has confirm guard",
  plansSrc.includes("deletePlan") && plansSrc.includes("confirm"),
);

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n[smoke] ${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  process.exit(1);
}

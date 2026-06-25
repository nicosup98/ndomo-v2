// ─── Health Route ─────────────────────────────────────────────────────────────
/**
 * GET /health — public liveness probe (no auth required).
 *
 * Returns server status, version, uptime, and DB health check.
 * Status is "ok" when DB responds, "degraded" when DB query fails.
 */
import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";

// Read version once at import time — static for process lifetime
let cachedVersion = "0.1.0";
try {
  const pkg = await import("../../../package.json", { with: { type: "json" } });
  cachedVersion = pkg.default?.version ?? "0.1.0";
} catch {
  // Fallback if package.json not accessible
}

export function healthRoute(db: Database) {
  return new Elysia({ name: "health" }).get(
    "/health",
    async () => {
      let dbHealthy = true;
      try {
        db.query("SELECT 1").get();
      } catch {
        dbHealthy = false;
      }

      return {
        status: dbHealthy ? ("ok" as const) : ("degraded" as const),
        version: cachedVersion,
        uptime: Math.floor(process.uptime() * 1000),
        timestamp: Date.now(),
        dbHealthy,
      };
    },
    {
      response: {
        200: t.Object({
          status: t.Union([t.Literal("ok"), t.Literal("degraded")]),
          version: t.String(),
          uptime: t.Number(),
          timestamp: t.Number(),
          dbHealthy: t.Boolean(),
        }),
      },
    },
  );
}

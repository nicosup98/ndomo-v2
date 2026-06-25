// ─── HTTP Server Builder ──────────────────────────────────────────────────────
/**
 * Builds and starts the Elysia HTTP server for ndomo.
 *
 * Encapsulation order:
 * 1. securityHeaders (global)
 * 2. corsMiddleware (global)
 * 3. httpBasicAuth (global — applied to /api/* via guard, exempt /health)
 * 4. health route (no auth)
 * 5. /api/plans, /api/tasks, /api/sessions (auth required)
 */
import type { Database } from "bun:sqlite";
import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { Elysia } from "elysia";
import type { HttpConfig } from "../config/schema.ts";
import { httpBasicAuth } from "./auth.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { eventsRoute } from "./routes/events.ts";
import { healthRoute } from "./routes/health.ts";
import { plansRoute } from "./routes/plans.ts";
import { sessionsRoute } from "./routes/sessions.ts";
import { tasksRoute } from "./routes/tasks.ts";

interface BuildHttpServerArgs {
  db: Database;
  httpConfig: HttpConfig;
  /** OpenCode SDK client for SSE events. If null/undefined, /api/events returns 503. */
  sdkClient?: OpencodeClient;
}

export interface HttpServerHandle {
  port: number;
  stop: () => Promise<void>;
}

/**
 * Build the Elysia app with all middleware and routes.
 * Returns the app instance and a listen function.
 *
 * @throws if port is out of range 1-65535
 * @throws if auth is required but OPENCODE_SERVER_PASSWORD is not set
 */
export async function buildHttpServer(args: BuildHttpServerArgs) {
  const { db, httpConfig } = args;

  // Validate port range
  if (httpConfig.port < 1 || httpConfig.port > 65535) {
    throw new Error(`Invalid HTTP port: ${httpConfig.port}. Must be 1-65535.`);
  }

  // If auth required but password not set, fail fast (do not start)
  if (httpConfig.auth.required && !process.env.OPENCODE_SERVER_PASSWORD) {
    throw new Error(
      "HTTP auth is required but OPENCODE_SERVER_PASSWORD is not set. Cannot start server.",
    );
  }

  // Build the protected API sub-app first
  const apiProtected = new Elysia({ name: "api-protected" })
    .use(httpBasicAuth(httpConfig))
    .use(plansRoute(db))
    .use(tasksRoute(db))
    .use(sessionsRoute(db))
    .use(eventsRoute(args.sdkClient ?? null));

  // Compose the full app
  const app = new Elysia({ name: "ndomo-http" })
    .use(securityHeaders)
    .use(corsMiddleware(httpConfig.cors.origins))
    .use(healthRoute(db))
    .use(apiProtected);

  return {
    app: app as unknown as Elysia,
    listen: async (port: number): Promise<HttpServerHandle> => {
      const server = app.listen(port);
      return {
        port,
        stop: async () => {
          server.stop();
        },
      };
    },
  };
}

/**
 * Convenience: build + listen in one call.
 * Returns the running server handle.
 */
export async function startHttpServer(args: BuildHttpServerArgs): Promise<HttpServerHandle> {
  const { listen } = await buildHttpServer(args);
  return listen(args.httpConfig.port);
}

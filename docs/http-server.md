# HTTP Server (Phase 1)

## Overview

The optional **ndomo HTTP server** exposes the plugin's SQLite state (plans, tasks, sessions) as a read-only REST API and bridges the OpenCode SDK event stream as Server-Sent Events. Built on [Elysia](https://elysiajs.com/) with `@opencode-ai/sdk` for upstream connectivity.

**Phase 1 scope:** read-only REST endpoints + live SSE event relay. No HTTP writes to the DB, no WebSocket, no JWT. Phase 2 will introduce peer-spawning actions.

**Feature flag:** `NDOMO_HTTP_ENABLED=false` by default. The server does not bind a port unless explicitly enabled. CLI `--force` flag can override.

**Why it exists:** lets external clients (custom dashboards, scripts, browsers) observe ndomo's multi-agent activity without running inside OpenCode. Decouples consumer clients from OpenCode's session lifecycle.

## Quickstart

```bash
# 1. Configure (only OPENCODE_SERVER_PASSWORD is mandatory when auth enabled)
export NDOMO_HTTP_ENABLED=true
export NDOMO_HTTP_PORT=4097
export OPENCODE_SERVER_PASSWORD='pick-a-strong-passphrase'

# 2. Start the server from your project root (where .ndomo/state.db lives)
bun run src/cli/serve.ts

# 3. Liveness probe (no auth)
curl -fsS localhost:4097/health

# 4. Authenticated read
curl -fsS -u "user:$OPENCODE_SERVER_PASSWORD" localhost:4097/api/plans

# 5. Live SSE stream (Ctrl-C to disconnect)
curl -N -u "user:$OPENCODE_SERVER_PASSWORD" localhost:4097/api/events
```

## Configuration

All settings have sensible defaults; only `OPENCODE_SERVER_PASSWORD` is required when auth is enabled.

| Env var | Default | Purpose |
|---|---|---|
| `NDOMO_HTTP_ENABLED` | `false` | Master feature flag. Server binds port only when `true`. |
| `NDOMO_HTTP_PORT` | `4097` | TCP port. Avoids OpenCode default `4096`. |
| `NDOMO_HTTP_CORS_ORIGINS` | `*` | Comma-separated allowlist. `*` permits all origins (no credentials). |
| `NDOMO_HTTP_AUTH_REQUIRED` | `true` | HTTP Basic auth gate. Set `false` for local dev. |
| `OPENCODE_SERVER_PASSWORD` | (unset) | The HTTP Basic password. Server returns `503 auth_not_configured` if required + unset. |
| `OPENCODE_SERVER_URL` | `http://localhost:4096` | Upstream OpenCode server for SDK event relay. |

See [`.env.example`](.env.example) for full annotations.

## CLI usage

```
bun run src/cli/serve.ts [options]
```

Or via the unified CLI:

```
bun run src/cli/index.ts serve [options]
```

| Flag | Default | Effect |
|---|---|---|
| `--port <n>` | config (4097) | Override port (1-65535). |
| `--no-auth` | auth required | Disable HTTP Basic auth check (still loads `HttpConfig`). |
| `--cors <origins>` | config (`*`) | Comma-separated CORS origins, e.g. `https://app.example.com,https://admin.example.com`. |
| `--force` | off | Start even when `NDOMO_HTTP_ENABLED` is not `true`. |
| `--help`, `-h` | — | Print help and exit. |

**Examples:**

```bash
# Default config (auth enabled, CORS *)
bun run src/cli/serve.ts

# Local dev with auth off
bun run src/cli/serve.ts --no-auth --port 4098

# Production: explicit CORS allowlist
bun run src/cli/serve.ts --cors "https://app.example.com,https://admin.example.com"

# Bypass feature flag (for ad-hoc runs)
bun run src/cli/serve.ts --force --port 4099
```

**Graceful shutdown:** `SIGINT` and `SIGTERM` close the listener and DB cleanly. Exit code `0` on clean shutdown, `1` on startup failure.

## API reference

All `/api/*` endpoints require HTTP Basic auth (unless `--no-auth`). `/health` is always public.

| Method | Path | Auth | Query params | Response |
|---|---|---|---|---|
| `GET` | `/health` | no | — | `{ status, version, uptime, timestamp, dbHealthy }` |
| `GET` | `/api/plans` | yes | `status`, `sessionId`, `limit` (1-500) | `Plan[]` |
| `GET` | `/api/plans/search` | yes | `q` (required), `limit` (1-100) | `Plan[]` (FTS5) |
| `GET` | `/api/plans/:id` | yes | — | `Plan` or `404` |
| `GET` | `/api/tasks` | yes | `planId` (**required**), `status` | `Task[]` (422 if `planId` missing) |
| `GET` | `/api/tasks/search` | yes | `q` (required), `limit` (1-100) | `Task[]` (FTS5) |
| `GET` | `/api/tasks/:id` | yes | — | `Task` or `404` |
| `GET` | `/api/sessions` | yes | `planId`, `limit` (1-100) | `Session[]` |
| `GET` | `/api/sessions/active` | yes | — | `Session[]` (`endedAt === null`) |
| `GET` | `/api/sessions/:id` | yes | — | `Session` or `404` |
| `GET` | `/api/events` | yes | `types` (csv filter) | `text/event-stream` (SSE) |

### Health response shape

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 12345,
  "timestamp": 1735689600000,
  "dbHealthy": true
}
```

`status` is `"ok"` when the DB responds to `SELECT 1`, otherwise `"degraded"`.

### SSE response

`GET /api/events` returns `Content-Type: text/event-stream` with:

- A `hello` event on connect.
- Forwarded SDK events as `event: <type>` + `data: <json>` lines (default: all types).
- Optional filter: `?types=session.idle,session.error` (comma-separated type allowlist).
- A `: keepalive` comment every **30 seconds** to keep proxies from closing idle connections.
- The stream closes cleanly on client disconnect (abort signal) or SDK error.

If the SDK client is unreachable, the endpoint returns `503 sdk_unavailable` (no stream).

**Browser example:**

```js
const es = new EventSource("/api/events", { withCredentials: true });
// NOTE: EventSource cannot set Authorization. Use a short-lived token via query string (Phase 3).
es.addEventListener("session.idle", (e) => console.log("session idle:", e.data));
es.addEventListener("error", (e) => console.error("SSE error:", e));
```

For auth in the browser, Phase 3 will introduce short-lived SSE tokens via query string. Today, use HTTP Basic + a reverse proxy that injects `Authorization`, or call from server-side scripts only.

## Security notes

**HTTP Basic is plaintext over the wire.** Always run behind TLS in production (reverse proxy with nginx/Caddy, or `--force` over a VPN/localhost). HTTP Basic sends `base64(user:password)` — not encrypted, only obfuscated.

**CORS:**
- `NDOMO_HTTP_CORS_ORIGINS=*` permits any origin to call `/api/*` but **does not** send `Access-Control-Allow-Credentials`. Browser credentialed requests (cookies, `withCredentials`) will be rejected.
- For a real frontend, set explicit origins: `NDOMO_HTTP_CORS_ORIGINS=https://app.example.com`. Credentials are then allowed.

**Security headers** applied to every response (from `SECURITY_HEADERS` in `src/config/schema.ts`):

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `X-XSS-Protection` | `1; mode=block` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` |
| `Permissions-Policy` | `interest-cohort=()` |
| `X-Powered-By` | `ndomo` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (when `NODE_ENV=production`) |

**Localhost-only recommendation:** the server has no rate limiting and no per-user audit trail. For multi-tenant exposure, put it behind a reverse proxy that enforces auth, rate limits, and request logging.

**Password strength:** `OPENCODE_SERVER_PASSWORD` is the only gate. Use a passphrase ≥ 24 chars, or wire in a secret manager. Rotate via env reload + process restart.

**503 when password missing:** if `auth.required=true` and `OPENCODE_SERVER_PASSWORD` is unset, `/api/*` returns `503 auth_not_configured` with `WWW-Authenticate: Basic realm="ndomo"`. The `/health` endpoint stays public.

**No CSRF:** HTTP Basic is CSRF-immune (browser auto-supplies credentials only for same-origin requests, and cross-origin requests need explicit `withCredentials: true` + matching `Allow-Credentials`). For a frontend served from a different origin, set explicit CORS origins (not `*`).

## Troubleshooting

**Port already in use (`EADDRINUSE`).**
Another process bound the port. Check with `lsof -i :4097` or `ss -lntp | grep 4097`. Either kill the conflicting process or use `--port <free>`.

**`error: HTTP server is disabled (NDOMO_HTTP_ENABLED is not 'true').`**
Feature flag off. Either set `NDOMO_HTTP_ENABLED=true` or pass `--force` to the CLI.

**`503 auth_not_configured` on every request.**
`auth.required=true` but `OPENCODE_SERVER_PASSWORD` is empty. Export the env var and restart.

**CORS error in browser console: "No 'Access-Control-Allow-Origin' header".**
The request's `Origin` is not in `NDOMO_HTTP_CORS_ORIGINS` and `*` is not set. Either add the origin to the allowlist or set `*` for development (no credentials).

**SSE appears to hang / no events arrive.**
Two common causes:
1. **nginx buffering.** SSE responses need `X-Accel-Buffering: no` (the server sets this header, but a proxy might strip it). Configure your proxy: `proxy_buffering off;` (nginx) or `flush_interval -1` (HAProxy).
2. **OpenCode server unreachable.** The `/api/events` endpoint depends on `OPENCODE_SERVER_URL` (default `http://localhost:4096`). Verify with `curl -fsS localhost:4096/config`. If the OpenCode server is down, the endpoint returns `503 sdk_unavailable`.

**Connection drops after ~60s behind a load balancer.**
The server sends `: keepalive` every 30s. If you still see drops, the proxy is closing idle TCP connections faster than 30s. Either lower the keepalive in your proxy or configure TCP keepalive at the OS level.

**`422 validation_error: planId is required` from `/api/tasks`.**
`planId` is required (unlike `/api/sessions` which makes it optional). Pass `?planId=<uuid>`.

## Architecture

```
┌──────────┐        ┌──────────────────────────┐        ┌─────────────────────┐
│ Browser  │ HTTP+SSE│   ndomo Elysia server    │  SDK   │  OpenCode server    │
│ / curl   │────────▶│  :4097 (Phase 1)         │───────▶│  :4096              │
│ / script │  basic  │  ┌────────────────────┐  │  HTTP  │  ┌───────────────┐  │
│          │◀────────│  │ securityHeaders    │  │◀───────│  │ event.subscribe│  │
│          │         │  │ corsMiddleware     │  │  SSE   │  │ session.*     │  │
│          │         │  │ httpBasicAuth      │  │        │  │ ...           │  │
│          │         │  │ /health (public)   │  │        │  └───────────────┘  │
│          │         │  │ /api/plans (auth)  │  │        └─────────────────────┘
│          │         │  │ /api/tasks (auth)  │  │
│          │         │  │ /api/sessions      │  │        ┌─────────────────────┐
│          │         │  │ /api/events (SSE)  │──────────│ .ndomo/state.db     │
│          │         │  └────────────────────┘  │  SQL   │ (plans, tasks, ... )│
│          │         └──────────────────────────┘        └─────────────────────┘
```

- **Inbound:** `Elysia` handles auth (Basic), CORS, security headers, then dispatches to REST handlers or SSE stream.
- **REST handlers** are thin adapters — they delegate to `src/db/*.ts` (SQLite) and return JSON. No business logic in routes.
- **SSE** opens an async iterator on `sdkClient.event.subscribe()`, writes events through `SseWriter`, and cleans up on abort.
- **Outbound to OpenCode:** `getSdkClient()` creates a singleton `createOpencodeClient` configured with `baseUrl: OPENCODE_SERVER_URL` and `directory: process.cwd()` (project scoping via `x-opencode-directory` header).

## Files

| File | Purpose |
|---|---|
| `src/http/server.ts` | Elysia app builder + listen wrapper |
| `src/http/auth.ts` | HTTP Basic auth middleware (timing-safe compare, 503 on missing password) |
| `src/http/middleware/security-headers.ts` | OWASP baseline headers |
| `src/http/middleware/cors.ts` | CORS preflight + `Allow-Origin` logic |
| `src/http/routes/health.ts` | `GET /health` |
| `src/http/routes/plans.ts` | `/api/plans/*` |
| `src/http/routes/tasks.ts` | `/api/tasks/*` |
| `src/http/routes/sessions.ts` | `/api/sessions/*` |
| `src/http/routes/events.ts` | `/api/events` SSE relay |
| `src/http/sse.ts` | SSE format + writer + keepalive |
| `src/sdk/client.ts` | OpenCode SDK singleton (with health check) |
| `src/cli/serve.ts` | CLI entry point with flags |
| `src/config/schema.ts` | `loadHttpConfig()` + `SECURITY_HEADERS` |
| `src/http/__tests__/` | Unit + integration tests (528 tests total in repo) |
| `scripts/smoke-http.sh` | End-to-end smoke (5 curl assertions + headers) |

## See also

- [`.env.example`](.env.example) — annotated env reference
- [`docs/database.md`](database.md) — schema for `Plan`, `Task`, `Session`
- [`README.md`](../README.md) — quickstart + features
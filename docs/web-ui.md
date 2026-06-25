# Web UI

The ndomo HTTP server serves a Vue 3 single-page application (SPA) from the same port as the REST API. The UI provides read-only visibility into plans, tasks, and sessions.

## Architecture (single-port topology)

```
Browser  ──HTTP──>  Elysia :4097  ──/api/*──>  JSON responses (auth required)
                              └──/*──>  Vue SPA build artifacts from src/http/web/
```

- **One process**, one port. No CORS in production.
- **SPA fallback**: any non-`/api` GET request that doesn't match a static asset returns `src/http/web/index.html` (Vue Router hash mode — routes live in the URL fragment, e.g. `/#/plans/123`).
- **Auth**: Basic Auth via `OPENCODE_SERVER_PASSWORD`. Browser prompts on first visit, password stored in `sessionStorage`.
- **Read-only MVP**: all current API endpoints are GET; no write UI yet.

## Build pipeline

```
web/src/                 (Vue 3 SFCs, TS, CSS)
   │
   │ bun run web:build
   ▼
src/http/web/            (built artifacts — gitignored, regenerated)
   ├── index.html
   └── assets/
       ├── index-*.js    (hashed JS bundles)
       └── index-*.css   (hashed CSS bundles)
```

- `bun run web:dev` — Vite dev server on `:5173` with `/api` proxy to `:4097` Elysia. Use for SPA development (HMR).
- `bun run web:build` — production build to `src/http/web/`. Required before starting Elysia for production.
- `bun run web:typecheck` — vue-tsc strict mode check.
- `bun run web:test` — Vitest unit tests (api client, composables, components).

## Running locally

1. Build the SPA: `bun run web:build`
2. Start the server: `NDOMO_HTTP_ENABLED=true OPENCODE_SERVER_PASSWORD=secret bun run src/cli/serve.ts`
3. Open `http://localhost:4097/` in your browser.
4. Enter the password when prompted.

Vite dev mode (HMR):

1. Terminal 1: `NDOMO_HTTP_ENABLED=true OPENCODE_SERVER_PASSWORD=secret bun run src/cli/serve.ts`
2. Terminal 2: `bun run web:dev`
3. Open `http://localhost:5173/` — Vite proxies `/api/*` to Elysia.

## Deployment

Single binary / single process. No reverse proxy required for MVP. For production behind nginx/Caddy:

- Proxy `/api/*` and all other paths to Elysia on `:4097`.
- The SPA serves static assets with relative paths (`base: './'` in `vite.config.ts`), so it works under any sub-path.

## Security

- **Basic Auth** on `/api/*` (handled by Elysia middleware). `/health` and `/` are public.
- **Browser stores password in sessionStorage** (cleared on tab close). NOT localStorage. NOT cookies.
- **Same-origin only**: the SPA assumes it lives behind the same origin as the API. Cross-origin deployments require explicit CORS configuration.
- **SSE limitation**: `EventSource` cannot send custom headers in browsers. The MVP stubs the SSE composable and uses polling. A future iteration will switch to `fetch` + `ReadableStream` for SSE with auth.

## Extension guide (adding new panels)

To add a new view (e.g., Sessions browser):

1. Create `web/src/views/SessionsView.vue`.
2. Register the route in `web/src/router/index.ts`:
   ```ts
   { path: "/sessions", name: "sessions", component: () => import("@/views/SessionsView.vue") }
   ```
3. Add a nav link in `web/src/components/AppShell.vue` sidebar.
4. Add API client functions in `web/src/api/sessions.ts` (or new file).
5. Add types in `web/src/types/api.ts`.
6. Add a Vitest test in `web/__tests__/`.

No backend changes needed if the API already exists. Elysia auto-serves the new SPA build on next `bun run web:build`.

## Tests

- **Unit (Vitest)**: `bun run web:test` — api client, composables, components.
- **Integration**: `src/http/__tests__/spa.test.ts` — boots Elysia with fake SPA dist, tests static serving, SPA fallback, 503 when unbuilt.

## File map

```
web/
├── index.html
├── vite.config.ts
├── vitest.config.ts
├── tsconfig.json
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── api/             # fetch wrappers (plans, tasks, sessions, client)
│   ├── components/      # AppShell, AuthPrompt, StatusBadge, etc.
│   ├── composables/     # useApi, useAuth, useEvents (stubbed)
│   ├── router/          # vue-router config (hash mode)
│   ├── styles/          # tokens.css + globals.css
│   ├── types/           # api.ts (Plan, Task, Session, etc.)
│   └── views/           # Dashboard, PlanList, PlanDetail, TaskDetail, NotFound
└── __tests__/           # Vitest specs
```

## Environment variables

| var | purpose | default |
|---|---|---|
| `VITE_API_BASE` | Override API base URL (Vite build-time) | empty (same-origin) |
| `OPENCODE_SERVER_PASSWORD` | HTTP Basic Auth password | required when `http.auth.required=true` |
| `NDOMO_HTTP_ENABLED` | Enable HTTP server | `false` |
| `NDOMO_HTTP_PORT` | HTTP server port | `4097` |

## Known limitations

- SSE deferred (auth limitation in `EventSource`). MVP polls.
- No write UI yet (all API endpoints are GET-only).
- Hash mode routing: URLs include `#` (e.g., `localhost:4097/#/plans`). Clean URLs require switching to `createWebHistory` + server-side history fallback.

## See also

- [`docs/http-server.md`](http-server.md) — REST API reference, CLI flags, CORS, security headers
- [`.env.example`](../.env.example) — annotated env reference
- [`README.md`](../README.md) — quickstart + features

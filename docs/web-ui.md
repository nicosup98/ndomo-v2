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

## Write UI

Since 0.3.0 the SPA ships with a full write layer that mirrors the CLI and HTTP API:

- **Create a plan** — `/plans/new` (`CreatePlanView` + `CreatePlanForm`). Reachable from the PlanList header (`+ Create Plan` button).
- **Edit a plan** — `EditPlanForm` embedded on the PlanDetail page (title, overview, approach, priority, complexity, category).
- **Create a task** — `CreateTaskForm` on the PlanDetail page (description, agent, files, complexity).
- **Lifecycle actions** — `StatusActions` renders only the buttons valid for the current status:
  - Plan: `draft` → Approve; `approved`/`executing` → Mark Complete / Fail; terminal → Archive (delete).
  - Task: `pending`/`running` → Mark Done / Mark Failed / Reassign; terminal → Delete.
- **Reassign a task** — `AgentReassignDropdown` lists the available agents (craftsman, js-smith, vue-smith, go-smith, python-smith, rust-smith, smith, ranger, scout, scribe, inspector, chronicler, painter).

All writes go through `usePlanMutations` / `useTaskMutations` composables, which call the matching `/api/*` endpoints and surface `isLoading` / `error` refs to the components. SSE events (`plan.created`, `task.updated`, etc.) are emitted server-side on success; the SPA refreshes affected views via `useSseRefresh`.

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

## Styling with Bulma

The Web UI uses **[Bulma 1.0](https://bulma.io)** as its CSS framework.

### Why Bulma

- **CSS-only**: no JavaScript runtime, no jQuery dependency. Styles load from a single CSS import.
- **Mature and semantic**: well-documented class names (`is-primary`, `is-success`, `has-text-danger`) map directly to intent.
- **Low learning curve**: utility-free — class names describe what they do.
- **Modern**: built on CSS custom properties, responsive by default.

### How it works

Bulma is imported once in `web/src/styles/main.css`:

```css
/* main.css */
@import "bulma/css/bulma.min.css";

:root {
  /* ndomo status palette */
  --status-pending: #8b95a3;
  --status-running: #5eb3ff;
  --status-done: #6ee7b7;
  --status-failed: #ef4444;
  --status-blocked: #f59e0b;
  /* plan statuses */
  --status-draft: #6b7280;
  --status-approved: #a78bfa;
  --status-executing: #5eb3ff;
  --status-completed: #6ee7b7;
  --status-abandoned: #5a6470;
}
```

### Using Bulma in Vue templates

Bulma classes are plain strings on standard HTML elements:

```html
<div class="card">
  <header class="card-header">
    <p class="card-header-title">Plan: rebuild web UI</p>
  </header>
  <div class="card-content">
    <span class="tag is-success">completed</span>
  </div>
</div>
```

No `<script>` import needed — Bulma is a stylesheet, not a component library.

### Status palette

Status colors live as CSS custom properties in `main.css`. Reference them in custom styles:

```css
.status-badge--pending { color: var(--status-pending); }
```

### Adding custom utility classes

Add plain CSS to `main.css`. No preprocessors required — Bulma 1.0 is fully customizable via CSS variables.

> **Note:** `sass` is **not** a dependency. SCSS customization is deferred — evaluate later if Bulma variable overrides or mixins become necessary.

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
│   ├── components/      # AppShell, AuthPrompt, StatusBadge, CreatePlanForm,
│   │                    # EditPlanForm, CreateTaskForm, StatusActions,
│   │                    # AgentReassignDropdown, etc.
│   ├── composables/     # useApi, useAuth, useEvents, useSseRefresh,
│   │                    # usePlanMutations, useTaskMutations
│   ├── router/          # vue-router config (hash mode)
│   ├── styles/          # main.css (Bulma import + status palette)
│   ├── types/           # api.ts (Plan, Task, Session, body interfaces)
│   └── views/           # Dashboard, PlanList, PlanDetail, TaskDetail,
│                        # CreatePlanView, NotFound
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

- SSE deferred (auth limitation in `EventSource`). MVP polls for the read layer; the write layer relies on per-call refresh after success. A future iteration will switch to `fetch` + `ReadableStream` for SSE with auth.
- Hash mode routing: URLs include `#` (e.g., `localhost:4097/#/plans`). Clean URLs require switching to `createWebHistory` + server-side history fallback.

## See also

- [`docs/http-server.md`](http-server.md) — REST API reference, CLI flags, CORS, security headers
- [`.env.example`](../.env.example) — annotated env reference
- [`README.md`](../README.md) — quickstart + features

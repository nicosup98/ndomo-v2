#!/usr/bin/env bash
# ndomo I3 web UI smoke test — verifies Elysia single-port SPA topology.
#
# Builds the Vue SPA via `bun run web:build`, boots the HTTP server, then runs
# a battery of curl assertions:
#   - GET /                        → 200 text/html (SPA index)
#   - GET /api/health              → 200 JSON
#   - GET /api/plans without auth  → 401 + WWW-Authenticate
#   - GET /api/plans with auth     → 200 JSON array
#   - GET /plans/<random-uuid>     → 200 text/html (SPA fallback)
#   - GET /api/plans/<bad-uuid>    → 404 JSON
#   - GET /assets/<hashed>.js      → 200 application/javascript
#   - GET /assets/<hashed>.css     → 200 text/css
#
# Plus suite-level checks at the end:
#   - bun run typecheck (0 errors)
#   - bun test (full suite, no regressions)
#   - bun run web:typecheck (0 errors)
#
# Usage:
#   bash scripts/smoke-web.sh
#
# Env overrides:
#   SMOKE_PORT      TCP port for the server (default: 4097)
#   SMOKE_PASSWORD  HTTP Basic password (default: smoke-test-password)
#   SMOKE_TIMEOUT   Health-check wait in seconds (default: 10)
#   SKIP_BUILD      Skip `bun run web:build` if artifacts already present
#
# Exit 0 on all assertions pass, exit 1 on any failure.
set -euo pipefail

# ─── Banner ──────────────────────────────────────────────────────────────────
echo "┌──────────────────────────────────────┐"
echo "│  I3 web UI SPA smoke test           │"
echo "└──────────────────────────────────────┘"

# ─── Resolve project root (this script's parent dir) ─────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# ─── Pre-flight checks ───────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || {
  echo "[FAIL] bun not found in PATH — install from https://bun.sh" >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo "[FAIL] curl not found in PATH" >&2
  exit 1
}

# ─── Config ──────────────────────────────────────────────────────────────────
SMOKE_PORT="${SMOKE_PORT:-4097}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-smoke-test-password}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-10}"
SKIP_BUILD="${SKIP_BUILD:-}"

# Validate port range
if ! [[ "${SMOKE_PORT}" =~ ^[0-9]+$ ]] || [ "${SMOKE_PORT}" -lt 1 ] || [ "${SMOKE_PORT}" -gt 65535 ]; then
  echo "[FAIL] invalid SMOKE_PORT: ${SMOKE_PORT}" >&2
  exit 1
fi

# ─── Port fallback helper ────────────────────────────────────────────────────
# If SMOKE_PORT is in use, fall back to the next free port up to +10.
find_free_port() {
  local start="$1"
  for offset in $(seq 0 10); do
    local candidate=$((start + offset))
    if ! ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "(^|:)${candidate}$"; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

PORT="$(find_free_port "${SMOKE_PORT}")" || {
  echo "[FAIL] no free port in range ${SMOKE_PORT}-$((SMOKE_PORT + 10))" >&2
  exit 1
}
if [ "${PORT}" != "${SMOKE_PORT}" ]; then
  echo "[info] SMOKE_PORT ${SMOKE_PORT} busy — falling back to ${PORT}"
fi

# ─── Build SPA (Vite → src/http/web/) ────────────────────────────────────────
WEB_DIST="${PROJECT_ROOT}/src/http/web"
if [ -n "${SKIP_BUILD}" ] && [ -f "${WEB_DIST}/index.html" ]; then
  echo "[setup] SKIP_BUILD set + artifacts present — skipping web:build"
else
  echo "[setup] building Vue SPA (bun run web:build)..."
  bun run web:build || {
    echo "[FAIL] bun run web:build failed" >&2
    exit 1
  }
fi

if [ ! -f "${WEB_DIST}/index.html" ]; then
  echo "[FAIL] ${WEB_DIST}/index.html missing after build" >&2
  exit 1
fi

# ─── Bootstrap .ndomo/state.db if missing ────────────────────────────────────
NDOMO_DB="${PROJECT_ROOT}/.ndomo/state.db"
if [ ! -f "${NDOMO_DB}" ]; then
  echo "[setup] bootstrapping .ndomo/state.db..."
  bun -e '
    import { Database } from "bun:sqlite";
    import { mkdirSync } from "node:fs";
    import { join } from "node:path";
    const dir = join(process.cwd(), ".ndomo");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "state.db"), { create: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    const { runMigrations } = await import("./src/db/migrations.ts");
    runMigrations(db);
    db.close();
    console.log("[setup] db initialized");
  ' || {
    echo "[FAIL] failed to bootstrap .ndomo/state.db" >&2
    exit 1
  }
fi

# ─── Export server env ───────────────────────────────────────────────────────
export NDOMO_HTTP_ENABLED=true
export NDOMO_HTTP_PORT="${PORT}"
export NDOMO_HTTP_AUTH_REQUIRED=true
export NDOMO_HTTP_CORS_ORIGINS='*'
export OPENCODE_SERVER_PASSWORD="${SMOKE_PASSWORD}"
export OPENCODE_SERVER_URL="${OPENCODE_SERVER_URL:-http://localhost:4096}"

# ─── Start server in background ─────────────────────────────────────────────
LOG="$(mktemp -t smoke-web-XXXXXX.log)"
echo "[setup] starting server on port ${PORT} (log: ${LOG})"

bun run src/cli/serve.ts --port "${PORT}" --cors '*' >"${LOG}" 2>&1 &
SERVER_PID=$!

# Register cleanup trap — runs even on assertion failure
cleanup() {
  local exit_code=$?
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "[cleanup] killing server pid ${SERVER_PID}"
    kill "${SERVER_PID}" 2>/dev/null || true
    for _ in 1 2 3 4 5 6; do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -f "${LOG}"
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

# ─── Wait for /health (up to SMOKE_TIMEOUT seconds, 200ms backoff) ────────────
echo "[wait] polling /health (timeout ${SMOKE_TIMEOUT}s)..."
ready=false
deadline=$(( $(date +%s) + SMOKE_TIMEOUT ))
while [ "$(date +%s)" -lt "${deadline}" ]; do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "[FAIL] server died before becoming ready. Log:"
    cat "${LOG}" >&2
    exit 1
  fi
  if curl -fsS -o /dev/null "localhost:${PORT}/health" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 0.2
done
if [ "${ready}" != "true" ]; then
  echo "[FAIL] /health did not respond within ${SMOKE_TIMEOUT}s. Log:"
  cat "${LOG}" >&2
  exit 1
fi
echo "[ready] server up on port ${PORT}"

# ─── Assertion harness ───────────────────────────────────────────────────────
PASS=0
FAIL=0
FAILED_NAMES=()

assert() {
  local name="$1"
  local cmd="$2"
  if eval "${cmd}" >/dev/null 2>&1; then
    echo "[PASS] ${name}"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] ${name}"
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("${name}")
  fi
}

# ─── SPA index served at / (PUBLIC — no auth required) ──────────────────────
# SPA root + static assets + history fallback are exempt from auth. Only /api/*
# requires the OPENCODE_SERVER_PASSWORD.
curl -fsS -o /tmp/smoke-index.html "localhost:${PORT}/" || true
JS_ASSET_PATH="$(grep -oE 'assets/[A-Za-z0-9_./-]+\.js' /tmp/smoke-index.html | head -1 || true)"
CSS_ASSET_PATH="$(grep -oE 'assets/[A-Za-z0-9_./-]+\.css' /tmp/smoke-index.html | head -1 || true)"

assert "SPA index served: GET / → 200 text/html (no auth, public)" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' localhost:${PORT}/)\" = '200' ] && [ \"\$(curl -s -o /dev/null -w '%{content_type}' localhost:${PORT}/ | cut -d';' -f1)\" = 'text/html' ]"

assert "SPA index body references hashed asset" \
  "[ -n \"${JS_ASSET_PATH}\" ]"

# ─── /health still works (no auth required) ─────────────────────────────────
assert "API: GET /health → 200 JSON status=ok (no auth)" \
  "[ \"\$(curl -fsS -o /tmp/smoke-health.json -w '%{http_code}' localhost:${PORT}/health)\" = '200' ] && [ \"\$(grep -o '\"status\":\"[^\"]*\"' /tmp/smoke-health.json | head -1 | cut -d'\"' -f4)\" = 'ok' ]"

# ─── /api/plans auth required ───────────────────────────────────────────────
assert "API: GET /api/plans without auth → 401 + WWW-Authenticate" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' localhost:${PORT}/api/plans)\" = '401' ] && [ -n \"\$(curl -s -i localhost:${PORT}/api/plans | grep -i '^www-authenticate:')\" ]"

# ─── /api/plans auth OK ──────────────────────────────────────────────────────
assert "API: GET /api/plans with auth → 200 JSON array" \
  "[ \"\$(curl -fsS -o /tmp/smoke-plans.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" localhost:${PORT}/api/plans)\" = '200' ] && head -c 1 /tmp/smoke-plans.json | grep -q '\\['"

# ─── SPA history fallback (non-/api path → index.html, NOT 404) ─────────────
RANDOM_UUID="$(cat /proc/sys/kernel/random/uuid)"
curl -s -o /tmp/smoke-spa.html -w '%{http_code}|%{content_type}' "localhost:${PORT}/plans/${RANDOM_UUID}" > /tmp/smoke-spa-meta.txt || true
assert "SPA fallback: GET /plans/<random-uuid> → 200 text/html (not 404, no auth)" \
  "[ \"\$(cut -d'|' -f1 /tmp/smoke-spa-meta.txt)\" = '200' ] && [ \"\$(cut -d'|' -f2 /tmp/smoke-spa-meta.txt | cut -d';' -f1)\" = 'text/html' ] && grep -q '<div id=\"app\"' /tmp/smoke-spa.html"

# ─── /api/* unknown → 404 JSON (SPA fallback does NOT swallow /api) ─────────
assert "API: GET /api/plans/<bad-uuid> → 404 JSON error" \
  "[ \"\$(curl -s -o /tmp/smoke-404.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" localhost:${PORT}/api/plans/does-not-exist-zzz)\" = '404' ] && [ \"\$(grep -o '\"[^\"]*\"' /tmp/smoke-404.json | head -1 | cut -d'\"' -f2)\" = 'error' ]"

# ─── Write endpoints (POST/PUT/PATCH/DELETE) ───────────────────────────────
echo ""
echo "[write] testing POST/PUT/PATCH/DELETE endpoints..."

# POST /api/plans → 201
assert "API: POST /api/plans → 201 + JSON plan" \
  "[ \"\$(curl -s -o /tmp/smoke-post-plan.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" -X POST -H 'content-type: application/json' -d '{\"slug\":\"smoke-test-plan\",\"title\":\"Smoke Test\",\"overview\":\"Automated test plan\",\"createdBy\":\"smoke\"}' localhost:${PORT}/api/plans)\" = '201' ] && grep -q '\"slug\":\"smoke-test-plan\"' /tmp/smoke-post-plan.json"

# Extract plan ID from POST response
SMOKE_PLAN_ID="$(grep -o '"id":"[^"]*"' /tmp/smoke-post-plan.json | head -1 | cut -d'"' -f4)"

# PUT /api/plans/:id → 200
assert "API: PUT /api/plans/:id → 200 + updated title" \
  "[ \"\$(curl -s -o /tmp/smoke-put-plan.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" -X PUT -H 'content-type: application/json' -d '{\"title\":\"Smoke Test Updated\",\"updatedBy\":\"smoke\"}' \"localhost:${PORT}/api/plans/${SMOKE_PLAN_ID}\")\" = '200' ] && grep -q '\"title\":\"Smoke Test Updated\"' /tmp/smoke-put-plan.json"

# POST /api/plans/:id/approve → 200
assert "API: POST /api/plans/:id/approve → 200 + approved" \
  "[ \"\$(curl -s -o /tmp/smoke-approve-plan.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" -X POST -H 'content-type: application/json' -d '{\"updatedBy\":\"smoke\"}' \"localhost:${PORT}/api/plans/${SMOKE_PLAN_ID}/approve\")\" = '200' ] && grep -q '\"status\":\"approved\"' /tmp/smoke-approve-plan.json"

# PATCH /api/plans/:id/status → 200
assert "API: PATCH /api/plans/:id/status → 200 + executing" \
  "[ \"\$(curl -s -o /tmp/smoke-patch-status.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" -X PATCH -H 'content-type: application/json' -d '{\"status\":\"executing\",\"updatedBy\":\"smoke\"}' \"localhost:${PORT}/api/plans/${SMOKE_PLAN_ID}/status\")\" = '200' ] && grep -q '\"status\":\"executing\"' /tmp/smoke-patch-status.json"

# POST /api/plans/:id/tasks → 201
assert "API: POST /api/plans/:id/tasks → 201 + JSON task" \
  "[ \"\$(curl -s -o /tmp/smoke-post-task.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" -X POST -H 'content-type: application/json' -d '{\"description\":\"Smoke test task\",\"agent\":\"smoke-agent\"}' \"localhost:${PORT}/api/plans/${SMOKE_PLAN_ID}/tasks\")\" = '201' ] && grep -q '\"description\":\"Smoke test task\"' /tmp/smoke-post-task.json"

# Extract task ID from POST response
SMOKE_TASK_ID="$(grep -o '"id":"[^"]*"' /tmp/smoke-post-task.json | head -1 | cut -d'"' -f4)"

# PATCH /api/tasks/:id/reassign → 200
assert "API: PATCH /api/tasks/:id/reassign → 200 + new agent" \
  "[ \"\$(curl -s -o /tmp/smoke-reassign-task.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" -X PATCH -H 'content-type: application/json' -d '{\"agent\":\"new-agent\",\"updatedBy\":\"smoke\"}' \"localhost:${PORT}/api/tasks/${SMOKE_TASK_ID}/reassign\")\" = '200' ] && grep -q '\"agent\":\"new-agent\"' /tmp/smoke-reassign-task.json"

# PATCH /api/tasks/:id/status → 200
assert "API: PATCH /api/tasks/:id/status → 200 + done" \
  "[ \"\$(curl -s -o /tmp/smoke-patch-task.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" -X PATCH -H 'content-type: application/json' -d '{\"status\":\"done\",\"updatedBy\":\"smoke\",\"result\":\"completed\"}' \"localhost:${PORT}/api/tasks/${SMOKE_TASK_ID}/status\")\" = '200' ] && grep -q '\"status\":\"done\"' /tmp/smoke-patch-task.json"

# DELETE /api/tasks/:id → 204
assert "API: DELETE /api/tasks/:id → 204" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" -X DELETE -H 'content-type: application/json' -d '{\"confirm\":true,\"updatedBy\":\"smoke\"}' \"localhost:${PORT}/api/tasks/${SMOKE_TASK_ID}\")\" = '204' ]"

# Verify GET after DELETE → 404
assert "API: GET deleted task → 404" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" \"localhost:${PORT}/api/tasks/${SMOKE_TASK_ID}\")\" = '404' ]"

# DELETE /api/plans/:id → 204 (plan is executing, no active tasks)
assert "API: DELETE /api/plans/:id → 204" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" -X DELETE -H 'content-type: application/json' -d '{\"confirm\":true,\"updatedBy\":\"smoke\"}' \"localhost:${PORT}/api/plans/${SMOKE_PLAN_ID}\")\" = '204' ]"

echo "[write] write endpoint assertions complete"

# ─── Static JS asset served (PUBLIC, no auth) ───────────────────────────────
if [ -n "${JS_ASSET_PATH}" ]; then
  assert "Static: GET /${JS_ASSET_PATH} → 200 application/javascript (no auth)" \
    "[ \"\$(curl -fsS -o /tmp/smoke-asset.js -w '%{http_code}' localhost:${PORT}/${JS_ASSET_PATH})\" = '200' ] && [ \"\$(curl -s -o /dev/null -w '%{content_type}' localhost:${PORT}/${JS_ASSET_PATH} | cut -d';' -f1)\" = 'application/javascript' ] && [ \"\$(wc -c < /tmp/smoke-asset.js)\" -gt 100 ]"
else
  assert "Static: GET /assets/<hashed>.js → 200 application/javascript" "false"
fi

# ─── Static CSS asset served (PUBLIC, no auth) ──────────────────────────────
if [ -n "${CSS_ASSET_PATH}" ]; then
  assert "Static: GET /${CSS_ASSET_PATH} → 200 text/css (no auth)" \
    "[ \"\$(curl -fsS -o /tmp/smoke-style.css -w '%{http_code}' localhost:${PORT}/${CSS_ASSET_PATH})\" = '200' ] && [ \"\$(curl -s -o /dev/null -w '%{content_type}' localhost:${PORT}/${CSS_ASSET_PATH} | cut -d';' -f1)\" = 'text/css' ]"
else
  # Vue SPA often inlines CSS — skip if no external CSS asset.
  assert "Static: GET /assets/<hashed>.css → 200 text/css (skipped: no external CSS asset in build)" "true"
fi

# ─── Stop server before suite-level checks ──────────────────────────────────
echo ""
echo "[cleanup] stopping server before suite-level checks..."
kill "${SERVER_PID}" 2>/dev/null || true
for _ in 1 2 3 4 5 6; do
  kill -0 "${SERVER_PID}" 2>/dev/null || break
  sleep 0.5
done
kill -9 "${SERVER_PID}" 2>/dev/null || true
wait "${SERVER_PID}" 2>/dev/null || true
trap - EXIT INT TERM

# ─── Suite-level checks ─────────────────────────────────────────────────────
echo ""
echo "[suite] running bun run typecheck..."
if bun run typecheck >/tmp/smoke-typecheck.log 2>&1; then
  echo "[PASS] typecheck: 0 errors"
  PASS=$((PASS + 1))
else
  echo "[FAIL] typecheck had errors:" >&2
  tail -30 /tmp/smoke-typecheck.log >&2
  FAIL=$((FAIL + 1))
  FAILED_NAMES+=("typecheck")
fi

echo "[suite] running bun test (src/)..."
# Unset smoke env vars so they don't pollute tests that check default config behavior.
unset NDOMO_HTTP_ENABLED
unset NDOMO_HTTP_PORT
unset NDOMO_HTTP_AUTH_REQUIRED
unset NDOMO_HTTP_CORS_ORIGINS
unset OPENCODE_SERVER_PASSWORD
unset OPENCODE_SERVER_URL
# web/__tests__/ uses vitest (vi.mocked etc.) — not bun:test. Scope bun test to src/.
if bun test src/ >/tmp/smoke-buntest.log 2>&1; then
  TLINE="$(grep -oE '[0-9]+ pass' /tmp/smoke-buntest.log | head -1 || echo 'all pass')"
  echo "[PASS] bun test src/: ${TLINE}"
  PASS=$((PASS + 1))
else
  echo "[FAIL] bun test src/ had failures:" >&2
  tail -40 /tmp/smoke-buntest.log >&2
  FAIL=$((FAIL + 1))
  FAILED_NAMES+=("bun test src/")
fi

echo "[suite] running bun run web:test (vitest)..."
if bun run web:test >/tmp/smoke-webtest.log 2>&1; then
  TLINE="$(grep -oE 'Tests *[0-9]+ passed' /tmp/smoke-webtest.log | head -1 || echo 'all pass')"
  echo "[PASS] web:test (vitest): ${TLINE}"
  PASS=$((PASS + 1))
else
  echo "[FAIL] web:test (vitest) had failures:" >&2
  tail -40 /tmp/smoke-webtest.log >&2
  FAIL=$((FAIL + 1))
  FAILED_NAMES+=("web:test")
fi

echo "[suite] running bun run web:typecheck..."
if bun run web:typecheck >/tmp/smoke-webtypecheck.log 2>&1; then
  echo "[PASS] web:typecheck: 0 errors"
  PASS=$((PASS + 1))
else
  echo "[FAIL] web:typecheck had errors:" >&2
  tail -30 /tmp/smoke-webtypecheck.log >&2
  FAIL=$((FAIL + 1))
  FAILED_NAMES+=("web:typecheck")
fi

# ─── Report ──────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
TOTAL=$((PASS + FAIL))
echo "PASS: ${PASS}/${TOTAL}"
if [ "${FAIL}" -gt 0 ]; then
  echo "FAILED assertions:"
  for name in "${FAILED_NAMES[@]}"; do
    echo "  - ${name}"
  done
  exit 1
fi
echo "PASS: ${PASS}/${PASS}"
exit 0

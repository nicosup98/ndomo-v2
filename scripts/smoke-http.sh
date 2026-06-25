#!/usr/bin/env bash
# ndomo Phase 1 HTTP server smoke test.
#
# Boots the Elysia HTTP server, runs a battery of curl assertions against
# REST + SSE endpoints, verifies security headers, then kills the server.
#
# Usage:
#   bash scripts/smoke-http.sh
#
# Env overrides:
#   SMOKE_PORT      TCP port for the server (default: 4097)
#   SMOKE_PASSWORD  HTTP Basic password (default: smoke-test-password)
#   SMOKE_TIMEOUT   Health-check wait in seconds (default: 10)
#
# Exit 0 on all assertions pass, exit 1 on any failure.
set -euo pipefail

# ─── Banner ──────────────────────────────────────────────────────────────────
echo "┌──────────────────────────────────────┐"
echo "│  Phase 1 HTTP server smoke test      │"
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
LOG="$(mktemp -t smoke-http-XXXXXX.log)"
echo "[setup] starting server on port ${PORT} (log: ${LOG})"

# Use --cors to ensure wildcard; --force is NOT needed because env enables it.
bun run src/cli/serve.ts --port "${PORT}" --cors '*' >"${LOG}" 2>&1 &
SERVER_PID=$!

# Register cleanup trap — runs even on assertion failure
cleanup() {
  local exit_code=$?
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "[cleanup] killing server pid ${SERVER_PID}"
    kill "${SERVER_PID}" 2>/dev/null || true
    # Wait up to 3s for graceful shutdown
    for _ in 1 2 3 4 5 6; do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 0.5
    done
    # Hard kill if still alive
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

assert "health 200 + status=ok" \
  "[ \"\$(curl -fsS -o /tmp/smoke-health.json -w '%{http_code}' localhost:${PORT}/health)\" = '200' ] && [ \"\$(grep -o '\"status\":\"[^\"]*\"' /tmp/smoke-health.json | head -1 | cut -d'\"' -f4)\" = 'ok' ]"

assert "auth required: no creds → 401 + WWW-Authenticate" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' localhost:${PORT}/api/plans)\" = '401' ] && [ -n \"\$(curl -s -i localhost:${PORT}/api/plans | grep -i '^www-authenticate:')\" ]"

assert "auth OK: /api/plans → 200 + JSON array" \
  "[ \"\$(curl -fsS -o /tmp/smoke-plans.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" localhost:${PORT}/api/plans)\" = '200' ] && head -c 1 /tmp/smoke-plans.json | grep -q '\\['"

assert "auth OK: /api/sessions/active → 200" \
  "[ \"\$(curl -fsS -o /tmp/smoke-sessions.json -w '%{http_code}' -u \"user:${SMOKE_PASSWORD}\" localhost:${PORT}/api/sessions/active)\" = '200' ]"

assert "CORS preflight OPTIONS /api/plans → 204 + ACAO" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: http://localhost' -H 'Access-Control-Request-Method: GET' localhost:${PORT}/api/plans)\" = '204' ] && [ -n \"\$(curl -s -i -X OPTIONS -H 'Origin: http://localhost' -H 'Access-Control-Request-Method: GET' localhost:${PORT}/api/plans | grep -i '^access-control-allow-origin:')\" ]"

# ─── Security headers (≥ 3 of the canonical set must be present) ────────────
HDRS_RAW="$(curl -s -i -u "user:${SMOKE_PASSWORD}" localhost:${PORT}/api/sessions/active || true)"
SEC_HITS=0
for h in "Strict-Transport-Security" "X-Content-Type-Options" "X-Frame-Options" "Content-Security-Policy" "Referrer-Policy"; do
  if printf "%s" "${HDRS_RAW}" | grep -qi "^${h}:"; then
    SEC_HITS=$((SEC_HITS + 1))
  fi
done
assert "security headers ≥ 3 present (got ${SEC_HITS})" \
  "[ ${SEC_HITS} -ge 3 ]"

# ─── SSE endpoint behavior ───────────────────────────────────────────────────
# Two valid outcomes:
#   A) OpenCode SDK up  → 200 + Content-Type: text/event-stream (real SSE stream)
#   B) OpenCode SDK down → 503 + JSON body { error: "sdk_unavailable" } (graceful fallback)
# The test passes if EITHER outcome occurs. Both indicate the SSE route is
# correctly wired (events.ts returns 503 when sdkClient is null).
SSE_HDRS="$(curl -s -i -N --max-time 2 -u "user:${SMOKE_PASSWORD}" "localhost:${PORT}/api/events" 2>/dev/null || true)"
SSE_BODY="$(printf '%s' "${SSE_HDRS}" | awk 'BEGIN{p=0} /^\r?$/{p=1; next} p{print}')"
SSE_STATUS="$(printf '%s' "${SSE_HDRS}" | head -1 | awk '{print $2}')"
if printf '%s' "${SSE_HDRS}" | grep -qi '^content-type:[[:space:]]*text/event-stream'; then
  assert "SSE: 200 + text/event-stream (SDK up)" "true"
elif [ "${SSE_STATUS}" = "503" ] && printf '%s' "${SSE_BODY}" | grep -q '"sdk_unavailable"'; then
  assert "SSE: 503 + sdk_unavailable (SDK down — graceful fallback)" "true"
else
  assert "SSE: 200/503 with correct Content-Type or sdk_unavailable body" "false"
fi

# ─── Report ──────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
echo "PASS: ${PASS}/${PASS}+${FAIL}"
if [ "${FAIL}" -gt 0 ]; then
  echo "FAILED assertions:"
  for name in "${FAILED_NAMES[@]}"; do
    echo "  - ${name}"
  done
  exit 1
fi
echo "PASS: ${PASS}/${PASS}"
exit 0
# ndomo — OpenCode multi-agent plugin container image
# Entry point: bun run src/index.ts
# Base image pinned to bun version from .bun-version (never use `latest`).
# Multi-stage build keeps final image lean (distroless, no shell).

# ---- Stage 1: Install dependencies ----
FROM oven/bun:1.3.14-distroless AS deps
WORKDIR /app

# Copy package manifests first for layer caching (deps only rebuild when manifests change)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy application source, bundled assets, and configuration
COPY src/ ./src/
COPY skills/ ./skills/
COPY agents/ ./agents/
COPY config/ ./config/
COPY scripts/ ./scripts/
COPY bin/ ./bin/
COPY tools/ ./tools/
COPY opencode.json tsconfig.json biome.json ./

# ---- Stage 2: Runtime ----
FROM oven/bun:1.3.14-distroless
WORKDIR /app

COPY --from=deps /app /app

# Plugins are invoked by the OpenCode host; peer deps provided at runtime.
# JSON-array form avoids shell dependency (distroless has no shell).
ENTRYPOINT ["bun", "run", "src/index.ts"]

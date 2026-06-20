---
name: Bun
description: Use when building, running, testing, or bundling JavaScript/TypeScript applications. Reach for Bun when you need to execute scripts, manage dependencies, run tests, or bundle code for production. Bun is a drop-in replacement for Node.js with integrated package manager, test runner, and bundler.
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill Reference

## Product Summary

Bun is an all-in-one JavaScript/TypeScript toolkit that replaces Node.js, npm, Jest, and esbuild. It ships as a single binary and includes:

- **Runtime**: Execute `.js`, `.ts`, `.jsx`, `.tsx` files with native transpilation (4x faster startup than Node.js)
- **Package Manager**: `bun install` (25x faster than npm) with workspaces, lockfiles, and global cache
- **Test Runner**: Jest-compatible `bun test` with snapshots, mocking, and watch mode
- **Bundler**: `bun build` for browsers, servers, and standalone executables

Key files and commands:
- `bunfig.toml` — Configuration file (optional, zero-config by default)
- `bun run <script>` — Execute package.json scripts or files
- `bun install` — Install dependencies
- `bun test` — Run tests
- `bun build` — Bundle code
- `package.json` — Standard Node.js manifest (Bun reads this)

Primary docs: https://bun.com/docs

---

## When to Use

**Use Bun when:**
- Running TypeScript/JSX files directly without compilation overhead
- Installing packages and managing dependencies (faster than npm/yarn/pnpm)
- Writing and running tests (Jest-compatible API)
- Bundling applications for production or deployment
- Building full-stack applications with server and client code
- Creating standalone executables from JavaScript/TypeScript
- Working in monorepos with workspaces
- Needing HTTP servers with `Bun.serve()`

**Bun replaces:**
- Node.js (runtime)
- npm/yarn/pnpm (package manager)
- Jest (test runner)
- esbuild/webpack (bundler)

---

## Quick Reference

### Runtime Commands

| Command | Purpose |
|---------|---------|
| `bun run file.ts` | Execute a TypeScript/JavaScript file |
| `bun run script-name` | Run a package.json script |
| `bun --watch run file.ts` | Watch mode (re-run on file changes) |
| `bun run -` | Read and execute code from stdin |
| `bun --bun run script` | Force script to use Bun instead of Node.js |

### Package Manager Commands

| Command | Purpose |
|---------|---------|
| `bun install` | Install all dependencies from package.json |
| `bun add <pkg>` | Add a package to dependencies |
| `bun add -d <pkg>` | Add as dev dependency |
| `bun add -g <pkg>` | Install globally |
| `bun remove <pkg>` | Remove a package |
| `bun update` | Update packages |
| `bun install --frozen-lockfile` | CI mode: fail if lockfile out of sync |
| `bun ci` | Equivalent to `bun install --frozen-lockfile` |

### Test Runner Commands

| Command | Purpose |
|---------|---------|
| `bun test` | Run all tests |
| `bun test --watch` | Watch mode |
| `bun test --test-name-pattern <pattern>` | Filter tests by name |
| `bun test --concurrent` | Run tests in parallel |
| `bun test --coverage` | Generate coverage report |
| `bun test --update-snapshots` | Update snapshot files |

### Bundler Commands

| Command | Purpose |
|---------|---------|
| `bun build ./index.ts --outdir ./dist` | Bundle for browser (default) |
| `bun build ./index.ts --target bun --outdir ./dist` | Bundle for Bun runtime |
| `bun build ./index.ts --target node --outdir ./dist` | Bundle for Node.js |
| `bun build ./index.ts --outfile ./cli --compile` | Create standalone executable |
| `bun build ./index.ts --watch` | Watch mode |

### Configuration File (bunfig.toml)

```toml
# Runtime settings
preload = ["./setup.ts"]
jsx = "react"
logLevel = "debug"

# Package manager
[install]
optional = true
dev = true
peer = true
linker = "hoisted"  # or "isolated"

# Test runner
[test]
root = "./__tests__"
coverage = true
coverageThreshold = 0.9

# Server defaults
[serve]
port = 3000

# Script execution
[run]
shell = "system"  # or "bun"
bun = true        # alias node to bun
```

---

## Decision Guidance

### When to use `bun run` vs `bun`

| Scenario | Use |
|----------|-----|
| Running a file: `bun run index.ts` | `bun run` (explicit) |
| Running a package.json script | `bun run script-name` (required) |
| Executing a file directly | `bun index.ts` (shorthand, same as `bun run`) |
| Running a system command | `bun run ls` (via `bun run`) |

### Installation strategy: hoisted vs isolated

| Strategy | Use When |
|----------|----------|
| `hoisted` (default for single packages) | Traditional npm behavior; dependencies flattened in `node_modules` |
| `isolated` (default for workspaces) | Strict dependency isolation; prevents phantom dependencies (pnpm-like) |

Set in `bunfig.toml`: `[install] linker = "hoisted"` or `"isolated"`

### Bundler target selection

| Target | Use For |
|--------|---------|
| `browser` (default) | Client-side code; prioritizes `"browser"` export condition |
| `bun` | Server-side code; optimized for Bun runtime; enables full-stack builds |
| `node` | Node.js compatibility; outputs `.mjs` with Node export conditions |

### Test execution: serial vs concurrent

| Mode | Use When |
|------|----------|
| Sequential (default) | Tests have shared state or order dependencies |
| `test.concurrent()` | Tests are independent and can run in parallel |
| `test.serial()` | Force sequential even with `--concurrent` flag |

---

## Workflow

### 1. Initialize a Project

```bash
bun init my-app
cd my-app
```

Bun creates `package.json`, `tsconfig.json`, and a starter file. Choose template: Blank, React, or Library.

### 2. Install Dependencies

```bash
bun install
# or add a specific package
bun add react
bun add -d @types/react
```

Bun creates `bun.lock` (text-based lockfile) and `node_modules/`.

### 3. Configure (Optional)

Create `bunfig.toml` in project root for Bun-specific settings. Most projects work without it.

```toml
[install]
linker = "isolated"

[test]
coverage = true
```

### 4. Run Code

Execute TypeScript/JavaScript directly:

```bash
bun run src/index.ts
# or via package.json script
bun run dev
```

### 5. Write Tests

Create `*.test.ts` or `*.spec.ts` files:

```ts
import { test, expect } from "bun:test";

test("addition", () => {
  expect(2 + 2).toBe(4);
});
```

Run tests:

```bash
bun test
bun test --watch
bun test --coverage
```

### 6. Bundle for Production

```bash
# Browser bundle
bun build ./src/index.tsx --outdir ./dist

# Server bundle
bun build ./src/server.ts --target bun --outdir ./dist

# Standalone executable
bun build ./cli.ts --outfile ./mycli --compile
```

### 7. Deploy

Commit `bun.lock` to version control. In CI/CD:

```bash
bun ci  # Install with frozen lockfile
bun run build
bun test
```

---

## Common Gotchas

**Lockfile format**: Bun v1.2+ uses text-based `bun.lock` by default. Old projects may have binary `bun.lockb`. Migrate with: `bun install --save-text-lockfile --frozen-lockfile --lockfile-only`

**Lifecycle scripts**: Bun does NOT run `postinstall` scripts for security. Add trusted packages to `package.json`: `"trustedDependencies": ["package-name"]`

**Node.js compatibility**: Bun aims for Node.js compatibility but is not 100% complete. Check [compatibility page](/runtime/nodejs-compat) for built-in modules and globals.

**TypeScript types**: If you see `Bun` global errors, install `@types/bun`: `bun add -d @types/bun` and configure `tsconfig.json` with `"lib": ["ESNext"]`

**Shebang handling**: Scripts with `#!/usr/bin/env node` run with Node.js by default. Use `bun run --bun script` to force Bun, or set `[run] bun = true` in `bunfig.toml`

**Test discovery**: Tests must match patterns: `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts`. Nested in subdirectories is fine.

**Bundler output**: Without `--outdir`, bundles are returned in memory (JavaScript API only). Always specify `--outdir` for CLI.

**Environment variables**: Bun auto-loads `.env`, `.env.local`, `.env.[NODE_ENV]`. Disable with `[env] file = false` in `bunfig.toml`

**Watch mode flags**: Put Bun flags immediately after `bun`: `bun --watch run dev` ✓, not `bun run dev --watch` ✗

**Monorepo filtering**: Use `--filter` with glob patterns: `bun install --filter 'packages/*'` or `bun run --filter 'ba*' test`

---

## Verification Checklist

Before submitting work with Bun:

- [ ] `bun install` runs without errors and creates `bun.lock`
- [ ] `bun run <script>` executes the intended code
- [ ] `bun test` passes all tests (or `bun test --coverage` meets threshold)
- [ ] `bun build` produces output files in `--outdir` without errors
- [ ] `bunfig.toml` is valid TOML (if present) and matches intended config
- [ ] `package.json` has correct `"scripts"`, `"dependencies"`, `"devDependencies"`
- [ ] TypeScript files have no type errors (use `tsc --noEmit` or IDE)
- [ ] Lockfile (`bun.lock`) is committed to version control
- [ ] No hardcoded paths; use relative imports or environment variables
- [ ] Test files follow naming convention: `*.test.ts` or `*.spec.ts`
- [ ] Bundled output is minified/optimized for production (use `--minify` if needed)
- [ ] Executable builds work: `./mycli --help` (if using `--compile`)

---

## Resources

**Comprehensive navigation**: https://bun.com/docs/llms.txt

**Critical documentation pages**:
1. [Runtime](https://bun.com/docs/runtime) — Execute files and scripts
2. [Package Manager](https://bun.com/docs/pm/cli/install) — Install and manage dependencies
3. [Test Runner](https://bun.com/docs/test) — Write and run tests
4. [Bundler](https://bun.com/docs/bundler) — Bundle code for production

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt
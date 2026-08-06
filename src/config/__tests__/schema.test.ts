/**
 * Tests for src/config/schema.ts — NdomoConfig + loadHttpConfig + loadNdomoConfig.
 *
 * Tests:
 * 1. loadHttpConfig() defaults when no env, no file
 * 2. loadHttpConfig() reads env vars when no file
 * 3. loadHttpConfig() prefers file http block over env vars
 * 4. loadNdomoConfig() reads/parses ndomo.config.json correctly
 * 5. loadNdomoConfig() returns empty object if file missing
 * 6. NdomoConfig.http is optional, parses valid HttpConfig shape
 * 7. resolveConfigDir() honors XDG_CONFIG_HOME
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHttpConfig, loadNdomoConfig, resolveConfigDir } from "../schema.ts";

let tmpDir: string;
const origEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const key of keys) {
    origEnv[key] = process.env[key];
  }
}

function restoreEnv(...keys: string[]): void {
  for (const key of keys) {
    if (origEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = origEnv[key];
    }
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ndomo-schema-"));
  saveEnv(
    "NDOMO_HTTP_ENABLED",
    "NDOMO_HTTP_PORT",
    "NDOMO_HTTP_CORS_ORIGINS",
    "NDOMO_HTTP_AUTH_REQUIRED",
    "XDG_CONFIG_HOME",
  );
});

afterEach(() => {
  restoreEnv(
    "NDOMO_HTTP_ENABLED",
    "NDOMO_HTTP_PORT",
    "NDOMO_HTTP_CORS_ORIGINS",
    "NDOMO_HTTP_AUTH_REQUIRED",
    "XDG_CONFIG_HOME",
  );
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("loadHttpConfig", () => {
  test("returns defaults when no env vars and no file", () => {
    delete process.env.NDOMO_HTTP_ENABLED;
    delete process.env.NDOMO_HTTP_PORT;
    delete process.env.NDOMO_HTTP_CORS_ORIGINS;
    delete process.env.NDOMO_HTTP_AUTH_REQUIRED;

    const fakePath = join(tmpDir, "nonexistent.json");
    const config = loadHttpConfig(fakePath);

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(4097);
    expect(config.cors.origins).toEqual(["*"]);
    expect(config.auth.required).toBe(true);
  });

  test("reads env vars when no file", () => {
    process.env.NDOMO_HTTP_ENABLED = "true";
    process.env.NDOMO_HTTP_PORT = "8080";
    process.env.NDOMO_HTTP_CORS_ORIGINS = "a.com,b.com";
    process.env.NDOMO_HTTP_AUTH_REQUIRED = "false";

    const fakePath = join(tmpDir, "nonexistent.json");
    const config = loadHttpConfig(fakePath);

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.cors.origins).toEqual(["a.com", "b.com"]);
    expect(config.auth.required).toBe(false);
  });

  test("prefers file http block over env vars", () => {
    // Env says port 8080
    process.env.NDOMO_HTTP_PORT = "8080";
    process.env.NDOMO_HTTP_ENABLED = "false";

    // File says port 3000, enabled true
    const filePath = join(tmpDir, "ndomo.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        http: {
          enabled: true,
          port: 3000,
          cors: { origins: ["example.com"] },
          auth: { required: false },
        },
      }),
    );

    const config = loadHttpConfig(filePath);

    // File wins
    expect(config.enabled).toBe(true);
    expect(config.port).toBe(3000);
    expect(config.cors.origins).toEqual(["example.com"]);
    expect(config.auth.required).toBe(false);
  });

  test("falls back to env vars when file has no http block", () => {
    process.env.NDOMO_HTTP_ENABLED = "true";
    process.env.NDOMO_HTTP_PORT = "9090";

    const filePath = join(tmpDir, "ndomo.json");
    writeFileSync(filePath, JSON.stringify({ plugins: ["ndomo"] }));

    const config = loadHttpConfig(filePath);

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(9090);
    expect(config.cors.origins).toEqual(["*"]);
  });

  test("falls back to env vars when file is missing", () => {
    process.env.NDOMO_HTTP_ENABLED = "true";
    process.env.NDOMO_HTTP_PORT = "5555";

    const config = loadHttpConfig(join(tmpDir, "missing.json"));

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(5555);
  });
});

describe("loadNdomoConfig", () => {
  test("reads and parses ndomo.json correctly", () => {
    const filePath = join(tmpDir, "ndomo.json");
    const data = {
      plugins: ["ndomo", "opencode-mem"],
      optionalPlugins: ["@tarquinen/opencode-dcp"],
      presets: {
        default: {
          foreman: { model: "minimax/MiniMax-M3", temperature: 0.3 },
        },
      },
    };
    writeFileSync(filePath, JSON.stringify(data));

    const config = loadNdomoConfig(filePath);

    expect(config.plugins).toEqual(["ndomo", "opencode-mem"]);
    expect(config.optionalPlugins).toEqual(["@tarquinen/opencode-dcp"]);
    expect(config.presets?.default?.foreman?.model).toBe("minimax/MiniMax-M3");
  });

  test("returns empty object if file is missing", () => {
    const config = loadNdomoConfig(join(tmpDir, "missing.json"));
    expect(config).toEqual({});
  });

  test("returns empty object if file is invalid JSON", () => {
    const filePath = join(tmpDir, "bad.json");
    writeFileSync(filePath, "not json {{{");

    const config = loadNdomoConfig(filePath);
    expect(config).toEqual({});
  });

  test("returns empty object if file is an array", () => {
    const filePath = join(tmpDir, "array.json");
    writeFileSync(filePath, JSON.stringify([1, 2, 3]));

    const config = loadNdomoConfig(filePath);
    expect(config).toEqual({});
  });

  test("http field is optional", () => {
    const filePath = join(tmpDir, "nohttp.json");
    writeFileSync(filePath, JSON.stringify({ plugins: ["ndomo"] }));

    const config = loadNdomoConfig(filePath);
    expect(config.http).toBeUndefined();
  });

  test("http field parses valid HttpConfig shape", () => {
    const filePath = join(tmpDir, "withhttp.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        http: {
          enabled: true,
          port: 4097,
          cors: { origins: ["*"] },
          auth: { required: true },
        },
      }),
    );

    const config = loadNdomoConfig(filePath);
    expect(config.http).toBeDefined();
    expect(config.http?.enabled).toBe(true);
    expect(config.http?.port).toBe(4097);
    expect(config.http?.cors.origins).toEqual(["*"]);
    expect(config.http?.auth.required).toBe(true);
  });
});

describe("resolveConfigDir", () => {
  test("uses XDG_CONFIG_HOME when set", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/test-xdg";
    const dir = resolveConfigDir();
    expect(dir).toBe("/tmp/test-xdg/opencode");
  });

  test("defaults to ~/.config/opencode when XDG not set", () => {
    delete process.env.XDG_CONFIG_HOME;
    const dir = resolveConfigDir();
    expect(dir).toContain(".config");
    expect(dir).toContain("opencode");
  });
});

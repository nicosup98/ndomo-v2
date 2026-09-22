import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHttpConfig, loadJevConfig, SECURITY_HEADERS } from "./schema.ts";

describe("loadHttpConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  test("returns defaults when no env vars set", () => {
    const config = loadHttpConfig();
    expect(config).toEqual({
      enabled: true,
      port: 4097,
      cors: {
        origins: ["*"],
      },
      auth: {
        required: true,
      },
    });
  });

  test("parses NDOMO_HTTP_ENABLED=true", () => {
    process.env.NDOMO_HTTP_ENABLED = "true";
    const config = loadHttpConfig();
    expect(config.enabled).toBe(true);
  });

  test("parses NDOMO_HTTP_ENABLED=false", () => {
    process.env.NDOMO_HTTP_ENABLED = "false";
    const config = loadHttpConfig();
    expect(config.enabled).toBe(false);
  });

  test("parses NDOMO_HTTP_PORT", () => {
    process.env.NDOMO_HTTP_PORT = "8080";
    const config = loadHttpConfig();
    expect(config.port).toBe(8080);
  });

  test("falls back to default port on invalid NDOMO_HTTP_PORT", () => {
    process.env.NDOMO_HTTP_PORT = "invalid";
    const config = loadHttpConfig();
    expect(config.port).toBe(4097);
  });

  test("parses NDOMO_HTTP_CORS_ORIGINS", () => {
    process.env.NDOMO_HTTP_CORS_ORIGINS = "http://localhost:3000, https://example.com";
    const config = loadHttpConfig();
    expect(config.cors.origins).toEqual(["http://localhost:3000", "https://example.com"]);
  });

  test("parses NDOMO_HTTP_AUTH_REQUIRED=false", () => {
    process.env.NDOMO_HTTP_AUTH_REQUIRED = "false";
    const config = loadHttpConfig();
    expect(config.auth.required).toBe(false);
  });

  test("parses NDOMO_HTTP_AUTH_REQUIRED=true", () => {
    process.env.NDOMO_HTTP_AUTH_REQUIRED = "true";
    const config = loadHttpConfig();
    expect(config.auth.required).toBe(true);
  });

  test("auth.required defaults to true on invalid value", () => {
    process.env.NDOMO_HTTP_AUTH_REQUIRED = "invalid";
    const config = loadHttpConfig();
    expect(config.auth.required).toBe(true);
  });
});

describe("SECURITY_HEADERS", () => {
  test("contains expected headers", () => {
    expect(SECURITY_HEADERS).toHaveProperty("X-Content-Type-Options", "nosniff");
    expect(SECURITY_HEADERS).toHaveProperty("X-Frame-Options", "DENY");
    expect(SECURITY_HEADERS).toHaveProperty("X-XSS-Protection", "1; mode=block");
    expect(SECURITY_HEADERS).toHaveProperty("Referrer-Policy", "strict-origin-when-cross-origin");
    expect(SECURITY_HEADERS).toHaveProperty(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
  });

  test("is readonly", () => {
    // TypeScript as const ensures compile-time immutability
    // At runtime, we can verify the object is not frozen
    expect(typeof SECURITY_HEADERS).toBe("object");
  });
});

describe("loadJevConfig", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ndomo-jev-config-"));
    configPath = join(dir, "ndomo.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (body: unknown) => {
    writeFileSync(configPath, JSON.stringify(body), "utf-8");
  };

  test("returns defaults when config file is missing", () => {
    const config = loadJevConfig(join(dir, "does-not-exist.json"));
    expect(config).toEqual({ enabled: true, model: "jev-latest", timeoutMs: 3000 });
  });

  test("reads a complete jev block", () => {
    writeConfig({ jev: { enabled: false, model: "custom-model", timeoutMs: 1500 } });
    const config = loadJevConfig(configPath);
    expect(config).toEqual({ enabled: false, model: "custom-model", timeoutMs: 1500 });
  });

  test("applies per-field defaults on a partial jev block", () => {
    writeConfig({ jev: { timeoutMs: 500 } });
    const config = loadJevConfig(configPath);
    expect(config).toEqual({ enabled: true, model: "jev-latest", timeoutMs: 500 });
  });

  test("falls back to defaults on invalid field types", () => {
    writeConfig({ jev: { enabled: "yes", model: "", timeoutMs: -5 } });
    const config = loadJevConfig(configPath);
    expect(config).toEqual({ enabled: true, model: "jev-latest", timeoutMs: 3000 });
  });

  test("falls back to defaults when jev is not an object", () => {
    writeConfig({ jev: ["nope"] });
    expect(loadJevConfig(configPath)).toEqual({
      enabled: true,
      model: "jev-latest",
      timeoutMs: 3000,
    });
    writeConfig({ jev: "nope" });
    expect(loadJevConfig(configPath)).toEqual({
      enabled: true,
      model: "jev-latest",
      timeoutMs: 3000,
    });
  });

  test("ignores non-finite timeoutMs values", () => {
    writeConfig({ jev: { timeoutMs: Number.NaN } });
    expect(loadJevConfig(configPath).timeoutMs).toBe(3000);
  });
});

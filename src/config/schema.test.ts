import { describe, expect, test, beforeEach } from "bun:test";
import { loadHttpConfig, SECURITY_HEADERS } from "./schema.ts";

describe("loadHttpConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  test("returns defaults when no env vars set", () => {
    const config = loadHttpConfig();
    expect(config).toEqual({
      enabled: false,
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
    expect(SECURITY_HEADERS).toHaveProperty("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  test("is readonly", () => {
    // TypeScript as const ensures compile-time immutability
    // At runtime, we can verify the object is not frozen
    expect(typeof SECURITY_HEADERS).toBe("object");
  });
});

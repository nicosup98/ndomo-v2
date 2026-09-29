import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJevConfig } from "./schema.ts";

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

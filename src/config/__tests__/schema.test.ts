/**
 * Tests for src/config/schema.ts — NdomoConfig + loadNdomoConfig.
 *
 * Tests:
 * 1. loadNdomoConfig() reads/parses ndomo.config.json correctly
 * 2. loadNdomoConfig() returns empty object if file missing
 * 3. resolveConfigDir() honors XDG_CONFIG_HOME
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNdomoConfig, resolveConfigDir } from "../schema.ts";

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
  saveEnv("XDG_CONFIG_HOME");
});

afterEach(() => {
  restoreEnv("XDG_CONFIG_HOME");
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("loadNdomoConfig", () => {
  test("reads and parses ndomo.json correctly", () => {
    const filePath = join(tmpDir, "ndomo.json");
    const data = {
      plugins: ["ndomo", "test-plugin"],
      optionalPlugins: ["@tarquinen/opencode-dcp"],
      presets: {
        default: {
          foreman: { model: "minimax/MiniMax-M3", temperature: 0.3 },
        },
      },
    };
    writeFileSync(filePath, JSON.stringify(data));

    const config = loadNdomoConfig(filePath);

    expect(config.plugins).toEqual(["ndomo", "test-plugin"]);
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

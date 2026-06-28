/**
 * Tests for loadDotenv() from src/cli/serve.ts.
 *
 * Uses bun:test with temp directories to verify .env loading behavior.
 *
 * Coverage:
 * 1. KEY=value → loaded into process.env
 * 2. KEY="value with spaces" → strips double quotes
 * 3. KEY='single quotes' → strips single quotes
 * 4. # comment and blank lines → skipped
 * 5. export KEY=value → strips prefix
 * 6. BOM at start of file → handled
 * 7. Shell env precedence → .env does NOT override existing process.env
 * 8. No .env file → no crash, returns 0
 * 9. Invalid line (no =) → skipped without throw
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotenv } from "../serve.ts";

let tmpDir: string;

// Keys we set during tests — cleaned up in afterEach
const TEST_KEYS = [
  "TEST_BASIC",
  "TEST_SPACES",
  "TEST_SINGLE",
  "TEST_EXPORT",
  "TEST_BOM",
  "TEST_PRECEDENCE",
  "TEST_INVALID",
  "TEST_HASH_IN_QUOTES",
];

function cleanEnv() {
  for (const k of TEST_KEYS) {
    delete process.env[k];
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ndomo-env-test-"));
  cleanEnv();
});

afterEach(() => {
  cleanEnv();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadDotenv", () => {
  test("loads KEY=value into process.env", () => {
    writeFileSync(join(tmpDir, ".env"), "TEST_BASIC=hello\n");
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_BASIC).toBe("hello");
  });

  test("strips double quotes from value", () => {
    writeFileSync(join(tmpDir, ".env"), 'TEST_SPACES="value with spaces"\n');
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_SPACES).toBe("value with spaces");
  });

  test("strips single quotes from value", () => {
    writeFileSync(join(tmpDir, ".env"), "TEST_SINGLE='single quotes'\n");
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_SINGLE).toBe("single quotes");
  });

  test("skips comments and blank lines", () => {
    writeFileSync(
      join(tmpDir, ".env"),
      "# this is a comment\n\nTEST_BASIC=ok\n  # indented comment\n\n",
    );
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_BASIC).toBe("ok");
  });

  test("strips export prefix", () => {
    writeFileSync(join(tmpDir, ".env"), "export TEST_EXPORT=from_export\n");
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_EXPORT).toBe("from_export");
  });

  test("handles BOM at start of file", () => {
    // \uFEFF is the BOM character
    writeFileSync(join(tmpDir, ".env"), "\uFEFFTEST_BOM=bom_value\n");
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_BOM).toBe("bom_value");
  });

  test("shell env wins — .env does NOT override existing process.env", () => {
    process.env.TEST_PRECEDENCE = "shell_value";
    writeFileSync(join(tmpDir, ".env"), "TEST_PRECEDENCE=dotenv_value\n");
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(0);
    expect(process.env.TEST_PRECEDENCE).toBe("shell_value");
  });

  test("returns 0 when no .env file exists", () => {
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(0);
  });

  test("skips invalid lines without throwing", () => {
    writeFileSync(
      join(tmpDir, ".env"),
      "INVALID LINE\nTEST_BASIC=valid\nno_equals_sign\n",
    );
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_BASIC).toBe("valid");
  });

  test("handles CRLF line endings", () => {
    writeFileSync(join(tmpDir, ".env"), "TEST_BASIC=crlf_value\r\n");
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_BASIC).toBe("crlf_value");
  });

  test("handles empty value", () => {
    writeFileSync(join(tmpDir, ".env"), "TEST_BASIC=\n");
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_BASIC).toBe("");
  });

  test("preserves internal # inside quoted values", () => {
    writeFileSync(join(tmpDir, ".env"), 'TEST_HASH_IN_QUOTES="value # not comment"\n');
    const loaded = loadDotenv(tmpDir);
    expect(loaded).toBe(1);
    expect(process.env.TEST_HASH_IN_QUOTES).toBe("value # not comment");
  });
});

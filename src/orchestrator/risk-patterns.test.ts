import { describe, expect, test } from "bun:test";
import {
  DIFF_MAX_BYTES,
  RISK_PATTERNS,
  type RiskPattern,
  type RiskSeverity,
  scanDiff,
} from "./risk-patterns.ts";

/** Builds a minimal single-hunk diff whose added lines start at line 1. */
function hunkDiff(file: string, added: string[]): string {
  return [`--- a/${file}`, `+++ b/${file}`, `@@ -1,1 +1,${added.length} @@`, ...added].join("\n");
}

/** Stateless match helper mirroring the scanner's lastIndex reset. */
function matchLine(pattern: RiskPattern, line: string): boolean {
  pattern.regex.lastIndex = 0;
  return pattern.regex.test(line);
}

describe("scanDiff", () => {
  test("1. clean diff yields no findings and no warnings", () => {
    const diff = [
      "diff --git a/src/clean.ts b/src/clean.ts",
      "index 111..222 100644",
      "--- a/src/clean.ts",
      "+++ b/src/clean.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
    ].join("\n");

    const result = scanDiff(diff);
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("2. eval( on an added line is high, with correct file and new-side line", () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +10,3 @@",
      "+eval(userInput);",
      "+const ok = 1;",
    ].join("\n");

    const result = scanDiff(diff);
    const finding = result.findings.find((f) => f.patternId === "eval-call");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("high");
    expect(finding?.file).toBe("src/x.ts");
    expect(finding?.line).toBe(10);
    expect(finding?.snippet).toBe("eval(userInput);");
  });

  test("3. .skip( is medium", () => {
    const result = scanDiff(hunkDiff("src/a.test.ts", ['+it.skip("x", () => {});']));
    const finding = result.findings.find((f) => f.patternId === "test-skip");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("medium");
  });

  test("4. innerHTML, rm -rf and chmod 777 are detected", () => {
    const result = scanDiff(
      hunkDiff("src/b.ts", [
        "+el.innerHTML = userInput;",
        '+await exec("rm -rf /tmp/x");',
        "+chmod 777 /etc/passwd",
      ]),
    );

    expect(result.findings.some((f) => f.patternId === "innerhtml")).toBe(true);
    const rm = result.findings.find((f) => f.patternId === "rm-rf");
    expect(rm?.severity).toBe("high");
    const chmod = result.findings.find((f) => f.patternId === "chmod-777");
    expect(chmod?.severity).toBe("high");
  });

  test("5. SQL concatenation is medium", () => {
    const result = scanDiff(
      hunkDiff("src/db.ts", ['+const q = "SELECT * FROM users WHERE id = " + userId;']),
    );
    const finding = result.findings.find((f) => f.patternId === "sql-concat");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("medium");
  });

  test("6. multi-file multi-hunk tracks files and new-side line numbers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,2 @@",
      " const a = 1;",
      "+eval(a);",
      "@@ -20,1 +30,2 @@",
      " const z = 1;",
      "+eval(z);",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -5,1 +50,1 @@",
      "+eval(b);",
    ].join("\n");

    const result = scanDiff(diff);
    const evals = result.findings.filter((f) => f.patternId === "eval-call");
    expect(evals.map((f) => `${f.file}:${f.line}`)).toEqual(["a.ts:2", "a.ts:31", "b.ts:50"]);
  });

  test("7. removed lines and +++ headers are never scanned", () => {
    const diff = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,1 @@",
      "-eval(dangerous);",
      "-chmod 777 /x",
      "+const safe = 1;",
    ].join("\n");

    const result = scanDiff(diff);
    expect(result.findings).toEqual([]);
    expect(result.findings.some((f) => f.file === "b/x.ts")).toBe(false);
  });

  test("8. context lines are not scanned", () => {
    const diff = [
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -1,3 +1,3 @@",
      " eval(contextDanger);",
      " chmod 777 ctx;",
      "-eval(removed);",
      "+const fine = 2;",
    ].join("\n");

    const result = scanDiff(diff);
    expect(result.findings).toEqual([]);
  });

  test("9. dedup keeps distinct patterns but collapses repeats of the same pattern", () => {
    const result = scanDiff(hunkDiff("src/z.ts", ["+eval(md5(data)); eval(again);"]));

    const ids = result.findings.map((f) => f.patternId).sort();
    expect(ids).toEqual(["eval-call", "weak-hash-md5"]);

    const keys = result.findings.map((f) => `${f.patternId}|${f.file}|${f.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("10. diffs over the byte cap are truncated with a warning but still scanned", () => {
    const header = ["--- a/big.ts", "+++ b/big.ts", "@@ -1,1 +1,1 @@", "+eval(early);"];
    const filler = Array.from({ length: 6000 }, (_, i) => `+const filler${i} = ${i};`);
    const big = [...header, ...filler].join("\n");

    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(DIFF_MAX_BYTES);

    const result = scanDiff(big);
    expect(result.truncated).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.patternId === "eval-call")).toBe(true);
  });

  test("11a. empty diff warns and yields no findings", () => {
    const result = scanDiff("   \n  ");
    expect(result.findings).toEqual([]);
    expect(result.warnings.some((w) => w.includes("empty"))).toBe(true);
  });

  test("11b. a diff without hunks warns and yields no findings", () => {
    const result = scanDiff("diff --git a/x b/x\nindex 1..2 100644\n");
    expect(result.findings).toEqual([]);
    expect(result.warnings.some((w) => w.includes("no hunks"))).toBe(true);
  });

  test("12. catalog is well-formed and each pattern matches a positive case only", () => {
    expect(RISK_PATTERNS.length).toBeGreaterThanOrEqual(16);
    expect(RISK_PATTERNS.length).toBeLessThanOrEqual(20);

    const ids = RISK_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const severities: RiskSeverity[] = ["low", "medium", "high"];
    const benign = "const total = items.length;";
    const positives: Record<string, string> = {
      "eval-call": "eval(userInput);",
      "new-function": 'const f = new Function("return 1");',
      "child-process-template": `exec(\`ls \${dir}\`);`,
      "sql-concat": 'const q = "SELECT * FROM t WHERE id = " + id;',
      "rm-rf": "rm -rf /tmp/x",
      "chmod-777": "chmod 777 file.sh",
      "sudo-usage": "sudo systemctl restart app",
      "test-skip": 'it.skip("x", () => {});',
      innerhtml: "el.innerHTML = userInput;",
      "dangerously-set-innerhtml": "return <div dangerouslySetInnerHTML={{ __html: x }} />;",
      "v-html": '<div v-html="content"></div>',
      "http-url": 'fetch("http://example.com/data");',
      "tls-verify-disabled": "const agent = { rejectUnauthorized: false };",
      "no-check-certificate": "wget --no-check-certificate https://x",
      "weak-hash-md5": "const h = md5(data);",
      "weak-hash-sha1": "const h = sha1(data);",
      "secret-literal": 'const apiKey = "supersecretvalue";',
      "aws-access-key": 'const k = "AKIAIOSFODNN7EXAMPLE";',
      "private-key-block": "-----BEGIN PRIVATE KEY-----",
    };

    for (const pattern of RISK_PATTERNS) {
      expect(severities).toContain(pattern.severity);
      expect(pattern.regex).toBeInstanceOf(RegExp);
      expect(pattern.regex.flags).toContain("g");
      expect(pattern.description.length).toBeGreaterThan(0);
      expect(pattern.category.length).toBeGreaterThan(0);

      const sample = positives[pattern.id];
      if (sample === undefined) {
        throw new Error(`missing positive case for pattern ${pattern.id}`);
      }
      expect(matchLine(pattern, sample)).toBe(true);
      expect(matchLine(pattern, benign)).toBe(false);
    }
  });

  test("13. every finding carries a trimmed snippet capped at 200 chars", () => {
    const long = `eval(${"a".repeat(300)});`;
    const result = scanDiff(hunkDiff("src/s.ts", [`+   ${long}   `]));

    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.snippet.length).toBeLessThanOrEqual(200);
      expect(finding.snippet).toBe(finding.snippet.trim());
    }
  });
});

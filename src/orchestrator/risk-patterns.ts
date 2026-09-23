// ─── Diff Risk Pattern Scanner ───────────────────────────────────────────────
/**
 * Deterministic, offline risk scanner for unified diffs.
 *
 * Why a static catalog and not a model call: the *action* (which line is
 * dangerous and how dangerous) must be reproducible and auditable. The catalog
 * below owns detection and severity; downstream classifiers (JEV) may only
 * refine the traffic light for ambiguous low/medium findings.
 *
 * Design constraints:
 * - Pure and synchronous. `scanDiff` never throws and never touches the network.
 * - Stateless regexes: every pattern carries the `g` flag, so its `lastIndex`
 *   is reset before each use. A shared `/g` regex used with `.test()` is a
 *   classic stateful bug; `testPattern` neutralizes it.
 * - Only ADDED lines (`+`) inside hunks are scanned. Headers (`+++ `, `--- `),
 *   removed (`-`) and context (` `) lines are ignored by construction.
 * - Bounded work: diffs over `DIFF_MAX_BYTES` are truncated head-first.
 */

/** Severity of a single risk finding. */
export type RiskSeverity = "low" | "medium" | "high";

/** A catalog entry describing one detectable risk. */
export type RiskPattern = {
  /** Unique slug, e.g. "eval-call". */
  id: string;
  /** Risk family, e.g. "injection" | "secrets" | "shell" | "filesystem". */
  category: string;
  severity: RiskSeverity;
  /** Global regex, applied to a single line. Stateless (lastIndex reset). */
  regex: RegExp;
  /** Human-readable description of the risk. */
  description: string;
};

/**
 * The frozen risk catalog. Kept intentionally small and obvious to avoid
 * false positives: every entry matches a concrete, reviewable construct.
 */
export const RISK_PATTERNS: readonly RiskPattern[] = [
  // ── injection ──────────────────────────────────────────────────────────────
  {
    id: "eval-call",
    category: "injection",
    severity: "high",
    regex: /(?<![.\w])eval\s*\(/g,
    description: "Dynamic code execution via eval(); untrusted input can run arbitrary code.",
  },
  {
    id: "new-function",
    category: "injection",
    severity: "high",
    regex: /\bnew\s+Function\s*\(/g,
    description: "Dynamic code execution via new Function(); equivalent to eval.",
  },
  {
    id: "sql-concat",
    category: "injection",
    severity: "medium",
    regex: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(?:\$\{|\+\s*["'`A-Za-z_$])/gi,
    description: "SQL built by concatenation/interpolation; SQL injection risk. Use parameters.",
  },
  // ── shell / process ────────────────────────────────────────────────────────
  {
    id: "child-process-template",
    category: "shell",
    severity: "high",
    regex: /\b(?:exec|execSync|spawn|spawnSync|execFile)\s*\([^)]*\$\{/g,
    description: "Shell command built from a template literal; command injection risk.",
  },
  {
    id: "sudo-usage",
    category: "shell",
    severity: "low",
    regex: /\bsudo\s+/g,
    description: "Privilege escalation via sudo; review whether elevated rights are required.",
  },
  // ── filesystem ─────────────────────────────────────────────────────────────
  {
    id: "rm-rf",
    category: "filesystem",
    severity: "high",
    regex: /\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\b/g,
    description: "Recursive force delete (rm -rf); can irreversibly destroy data.",
  },
  {
    id: "chmod-777",
    category: "filesystem",
    severity: "high",
    regex: /\bchmod\s+(?:-R\s+)?0?777\b/g,
    description: "World-writable permissions (chmod 777); weakens the security posture.",
  },
  // ── testing ────────────────────────────────────────────────────────────────
  {
    id: "test-skip",
    category: "testing",
    severity: "medium",
    regex:
      /\b(?:it|test|describe|context|suite)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe)\s*\(|\.skip\s*\(/g,
    description: "Focused/skipped test (.skip/.only/xit/xdescribe); can silently hide regressions.",
  },
  // ── xss ────────────────────────────────────────────────────────────────────
  {
    id: "innerhtml",
    category: "xss",
    severity: "medium",
    regex: /\.innerHTML\b/g,
    description: "Assignment to innerHTML; untrusted data can lead to DOM-based XSS.",
  },
  {
    id: "dangerously-set-innerhtml",
    category: "xss",
    severity: "medium",
    regex: /dangerouslySetInnerHTML/g,
    description: "React dangerouslySetInnerHTML; bypasses escaping and can enable XSS.",
  },
  {
    id: "v-html",
    category: "xss",
    severity: "high",
    regex: /\bv-html\b/g,
    description: "Vue v-html renders raw HTML; untrusted content can execute scripts.",
  },
  // ── network / config ───────────────────────────────────────────────────────
  {
    id: "http-url",
    category: "network",
    severity: "low",
    regex: /http:\/\/(?!localhost\b|127\.0\.0\.1\b|\[::1\])/g,
    description: "Plaintext http:// endpoint (non-localhost); traffic is unencrypted.",
  },
  {
    id: "tls-verify-disabled",
    category: "config",
    severity: "high",
    regex: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/g,
    description: "TLS certificate verification disabled; enables man-in-the-middle attacks.",
  },
  {
    id: "no-check-certificate",
    category: "network",
    severity: "medium",
    regex: /--no-check-certificate/g,
    description: "TLS verification disabled on the CLI (--no-check-certificate).",
  },
  // ── crypto ─────────────────────────────────────────────────────────────────
  {
    id: "weak-hash-md5",
    category: "crypto",
    severity: "medium",
    regex: /\bmd5\s*\(/gi,
    description: "MD5 is cryptographically broken; unsuitable for security-sensitive hashing.",
  },
  {
    id: "weak-hash-sha1",
    category: "crypto",
    severity: "medium",
    regex: /\bsha1\s*\(/gi,
    description: "SHA-1 is cryptographically broken; unsuitable for security-sensitive hashing.",
  },
  // ── secrets ────────────────────────────────────────────────────────────────
  {
    id: "secret-literal",
    category: "secrets",
    severity: "high",
    regex: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][^"']{8,}["']/gi,
    description: "Hardcoded secret/credential assigned to a string literal.",
  },
  {
    id: "aws-access-key",
    category: "secrets",
    severity: "high",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    description: "AWS access key id (AKIA...) committed in code.",
  },
  {
    id: "private-key-block",
    category: "secrets",
    severity: "high",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    description: "Private key material (PEM block) committed in code.",
  },
];

/** A single risk detected on an added line of a diff. */
export type RiskFinding = {
  patternId: string;
  category: string;
  severity: RiskSeverity;
  /** Diff path without the a/ or b/ prefix. */
  file: string;
  /** Line number on the NEW side of the diff (the `+` side). */
  line: number;
  /** Trimmed added line, capped at 200 characters. */
  snippet: string;
  description: string;
};

/** Maximum number of bytes scanned; larger diffs are truncated head-first. */
export const DIFF_MAX_BYTES = 100 * 1024;

/** Result of scanning a unified diff. */
export type ScanDiffResult = { findings: RiskFinding[]; truncated: boolean; warnings: string[] };

/** New-side start line of a hunk header: `@@ -a,b +c,d @@` → captures `c`. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Max snippet length in characters. */
const SNIPPET_MAX = 200;

/**
 * Stateless boolean match: resets `lastIndex` so a shared `/g` regex is safe
 * across lines and calls.
 */
function testPattern(regex: RegExp, line: string): boolean {
  regex.lastIndex = 0;
  return regex.test(line);
}

/**
 * Head-first truncation at `DIFF_MAX_BYTES` (UTF-8). If the cut lands mid-line,
 * the partial trailing line is dropped so the parser only sees whole lines.
 */
function truncateDiff(diff: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(diff, "utf8") <= DIFF_MAX_BYTES) {
    return { text: diff, truncated: false };
  }
  const head = Buffer.from(diff, "utf8").subarray(0, DIFF_MAX_BYTES).toString("utf8");
  const lastNewline = head.lastIndexOf("\n");
  const whole = lastNewline >= 0 ? head.slice(0, lastNewline + 1) : head;
  // Drop a dangling UTF-8 replacement char left by a mid-codepoint cut.
  return { text: whole.replace(/\uFFFD+$/, ""), truncated: true };
}

/** Extracts the normalized path from a `+++ b/path` header line. */
function parseFilePath(header: string): string {
  const raw = header.slice(4).trim();
  const [beforeTab] = raw.split("\t");
  const path = (beforeTab ?? raw).trim();
  return path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * Scan a unified diff for risky added lines.
 *
 * Only `+` lines inside hunks are examined; headers, removed lines and context
 * lines are ignored. Findings are deduplicated by (patternId, file, line).
 *
 * @param diff - A unified diff (as produced by `git diff`).
 * @returns Findings, a truncation flag, and advisory warnings. Never throws.
 */
export function scanDiff(diff: string): ScanDiffResult {
  const findings: RiskFinding[] = [];
  const warnings: string[] = [];

  if (diff.trim().length === 0) {
    return { findings, truncated: false, warnings: ["empty diff"] };
  }

  const { text, truncated } = truncateDiff(diff);
  if (truncated) {
    warnings.push(
      `diff exceeds ${DIFF_MAX_BYTES} bytes and was truncated; only the leading region was scanned`,
    );
  }

  const seen = new Set<string>();
  let file: string | null = null;
  let newLine = 0;
  let inHunk = false;
  let sawHunk = false;

  for (const raw of text.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = parseFilePath(raw);
      inHunk = false;
      continue;
    }
    if (raw.startsWith("--- ")) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = HUNK_HEADER.exec(raw);
      if (match) {
        newLine = Number(match[1]);
        inHunk = true;
        sawHunk = true;
      }
      continue;
    }
    if (!inHunk) continue;

    const marker = raw.charAt(0);
    if (marker === "+") {
      const content = raw.slice(1);
      for (const pattern of RISK_PATTERNS) {
        if (!testPattern(pattern.regex, content)) continue;
        const resolvedFile = file ?? "unknown";
        const key = `${pattern.id}\u0000${resolvedFile}\u0000${newLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          patternId: pattern.id,
          category: pattern.category,
          severity: pattern.severity,
          file: resolvedFile,
          line: newLine,
          snippet: content.trim().slice(0, SNIPPET_MAX),
          description: pattern.description,
        });
      }
      newLine += 1;
    } else if (marker === "-") {
      // Removed line: does not advance the new-side line counter.
    } else {
      // Context line (space-prefixed or empty): advances the new-side counter.
      newLine += 1;
    }
  }

  if (!sawHunk) {
    warnings.push("no hunks found / unparseable diff");
  }

  return { findings, truncated, warnings };
}

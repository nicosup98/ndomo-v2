/**
 * ndomo audit — permission check (check b).
 *
 * Reads the `permission:` block of every `agents/*.md` frontmatter (see
 * `frontmatter.ts`) and flags insecure declarations. Severity ladder — chosen
 * so the current repo scores clean and each tier means one specific risk:
 *
 * - `perm.bash-wildcard-allow` **ERROR** — bash grants `allow` to EVERY command
 *   (`bash: allow` scalar, or a `"*": allow` / `"* …": allow` rule): the agent
 *   runs arbitrary shell with no prompt. Unconditional shell = ERROR.
 * - `perm.bash-wildcard-allow` **WARN** — a wildcard `allow` rule whose prefix
 *   is in {@link DANGEROUS_PREFIXES} (rm/sudo/sh -c/pipes-to-shell/deploy
 *   verbs…): narrower than "everything", but destructive commands still run
 *   unattended. Prompt-worthy, not fatal → WARN.
 * - `perm.readonly-write` **ERROR** — a read-only agent (its `edit` denies the
 *   `*` pattern, i.e. `edit: deny` or `edit."*": deny`, e.g. `ranger`,
 *   `scout`, `sage`, `critic`) declares `write: allow` (scalar or
 *   `"*": allow`). Contradicts the read-only contract with an unrestricted
 *   write path → ERROR. Scoped edit allows under a denied `*` (ranger's
 *   `docs/analyses/**`) are intentional and NOT flagged.
 * - `perm.missing-block` **WARN** — a primary agent (frontmatter `mode:
 *   primary` or `agentRouting.<id>.mode === "primary"` in the config) declares
 *   no `permission:` block at all: OpenCode falls back to its own defaults,
 *   which may be broader than ndomo intends. WARN (not ERROR) because the
 *   harness still applies its baseline sandbox.
 *
 * Deterministic: agent ids sorted, no clock, no writes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type PermissionEntry, parseFrontmatter } from "./frontmatter.ts";
import type { Finding } from "./types.ts";

/**
 * Command prefixes where a wildcard `allow` rule is escalated from WARN-worth
 * nothing to a WARN: destructive, privileged, or unattended-deploy verbs.
 * Matched against the rule prefix before the first `*` (trimmed).
 */
export const DANGEROUS_PREFIXES: readonly string[] = [
  "rm",
  "rmdir",
  "sudo",
  "su",
  "chmod",
  "chown",
  "dd",
  "mkfs",
  "kill",
  "pkill",
  "shutdown",
  "reboot",
  "curl",
  "wget",
  "nc",
  "ssh",
  "scp",
  "docker rm",
  "docker system prune",
  "kubectl delete",
  "kubectl rollout undo",
  "terraform destroy",
  "git push",
  "git reset --hard",
  "git clean",
  "sh -c",
  "bash -c",
  "eval",
  "npm publish",
  "bun publish",
] as const;

/** `true` when `entry` is a plain scalar (`edit: allow`). */
function isScalar(entry: PermissionEntry | undefined): entry is string {
  return typeof entry === "string";
}

/** Scalar value of `entry` when it is a map keyed `"*"`. */
function wildcardValue(entry: PermissionEntry | undefined): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const value = entry["*"];
  return typeof value === "string" ? value : null;
}

/**
 * `true` when the bash entry grants `allow` to every command:
 * scalar `bash: allow`, or a map rule whose pattern matches everything
 * (`"*": allow`, `"* arg": allow`).
 */
function grantsAllCommands(entry: PermissionEntry | undefined): boolean {
  if (isScalar(entry)) return entry === "allow";
  if (typeof entry !== "object" || entry === null) return false;
  for (const [pattern, value] of Object.entries(entry)) {
    if (value !== "allow") continue;
    if (pattern.trim() === "*" || pattern.trim().startsWith("* ")) return true;
  }
  return false;
}

/**
 * `true` when a wildcard `allow` rule exists whose command prefix (text before
 * the first `*`) is in {@link DANGEROUS_PREFIXES}.
 */
function allowsDangerousPrefix(entry: PermissionEntry | undefined): string | null {
  if (isScalar(entry)) return null;
  if (typeof entry !== "object" || entry === null) return null;
  const dangerous = new Set(DANGEROUS_PREFIXES);
  for (const [pattern, value] of Object.entries(entry)) {
    if (value !== "allow") continue;
    const star = pattern.indexOf("*");
    if (star < 0) continue; // exact-match allow, not a wildcard
    const prefix = pattern.slice(0, star).trim();
    if (prefix.length === 0) continue; // handled by grantsAllCommands (ERROR)
    if (dangerous.has(prefix)) return pattern;
  }
  return null;
}

/**
 * `true` when the agent's `edit` permission denies the catch-all pattern —
 * the frontmatter marker of a read-only agent.
 */
function isReadOnlyAgent(permission: Record<string, PermissionEntry> | null): boolean {
  if (permission === null) return false;
  const edit = permission.edit;
  if (isScalar(edit)) return edit === "deny";
  return wildcardValue(edit) === "deny";
}

/** `true` when `entry` allows the catch-all (`allow` scalar or `"*": allow`). */
function allowsEverything(entry: PermissionEntry | undefined): boolean {
  if (isScalar(entry)) return entry === "allow";
  return wildcardValue(entry) === "allow";
}

/** Load `agents/<id>.md` frontmatter; `null` when unreadable. */
function readAgent(projectDir: string, id: string): ReturnType<typeof parseFrontmatter> | null {
  try {
    return parseFrontmatter(readFileSync(join(projectDir, "agents", `${id}.md`), "utf-8"));
  } catch {
    return null;
  }
}

/** Primary agent ids = frontmatter `mode: primary` ∪ config `agentRouting.*.mode === "primary"`. */
export function primaryAgentIds(
  agentIds: readonly string[],
  config: Record<string, unknown> | null,
  frontmatterOf: (id: string) => ReturnType<typeof parseFrontmatter> | null,
): Set<string> {
  const primaries = new Set<string>();
  const routing = config?.agentRouting;
  if (typeof routing === "object" && routing !== null && !Array.isArray(routing)) {
    for (const [id, value] of Object.entries(routing as Record<string, unknown>)) {
      if (
        typeof value === "object" &&
        value !== null &&
        (value as { mode?: unknown }).mode === "primary"
      ) {
        primaries.add(id);
      }
    }
  }
  for (const id of agentIds) {
    if (frontmatterOf(id)?.scalars.mode === "primary") primaries.add(id);
  }
  return primaries;
}

/**
 * Run the permission check over every `agents/*.md`.
 *
 * @param agentIds sorted agent ids (from `listAgentIds`)
 * @param config   parsed config (for `agentRouting.*.mode`)
 */
export function checkPermissions(
  projectDir: string,
  agentIds: readonly string[],
  config: Record<string, unknown> | null,
): Finding[] {
  const findings: Finding[] = [];
  const cache = new Map<string, ReturnType<typeof parseFrontmatter>>();
  const fm = (id: string): ReturnType<typeof parseFrontmatter> | null => {
    const hit = cache.get(id);
    if (hit) return hit;
    const parsed = readAgent(projectDir, id);
    if (parsed) cache.set(id, parsed);
    return parsed;
  };

  const primaries = primaryAgentIds(agentIds, config, fm);

  for (const id of agentIds) {
    const parsed = fm(id);
    if (parsed === null || !parsed.present) continue;
    const path = `agents/${id}.md`;
    const permission = parsed.permission;

    // (b.4) permission block absent in a primary agent → WARN.
    if (permission === null) {
      if (primaries.has(id)) {
        findings.push({
          code: "perm.missing-block",
          severity: "WARN",
          path,
          message: `primary agent "${id}" declares no permission: block (harness defaults apply)`,
          detail: { agent: id },
        });
      }
      continue;
    }

    // (b.1) unconditional bash allow → ERROR / dangerous-prefix allow → WARN.
    const bash = permission.bash;
    if (grantsAllCommands(bash)) {
      findings.push({
        code: "perm.bash-wildcard-allow",
        severity: "ERROR",
        path,
        message: `bash permission allows EVERY command without prompt in "${id}"`,
        detail: { agent: id, rule: isScalar(bash) ? "bash: allow" : '"*": allow' },
      });
    } else {
      const dangerous = allowsDangerousPrefix(bash);
      if (dangerous !== null) {
        findings.push({
          code: "perm.bash-wildcard-allow",
          severity: "WARN",
          path,
          message: `bash rule "${dangerous}" auto-allows a destructive/privileged command family in "${id}"`,
          detail: { agent: id, rule: dangerous },
        });
      }
    }

    // (b.2) read-only agent with an unrestricted write path → ERROR.
    if (isReadOnlyAgent(permission) && allowsEverything(permission.write)) {
      findings.push({
        code: "perm.readonly-write",
        severity: "ERROR",
        path,
        message: `read-only agent "${id}" (edit denies "*") grants write: allow`,
        detail: { agent: id },
      });
    }
  }

  return findings;
}

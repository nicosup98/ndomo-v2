/**
 * ndomo memory — identity tags.
 *
 * Replicates the verified opencode-mem tag algorithm (sha256 slice-16 over a
 * canonical identity string) with the `ndomo` prefix. Identity precedence for
 * projects: git-common-dir → remote URL → normalized path. For users:
 * git email → git name → $USER/$USERNAME → "anonymous".
 *
 * There are no CONFIG overrides in ndomo (unlike opencode-mem), so identity is
 * derived purely from the environment.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";

export type ProjectTagInfo = {
  tag: string;
  displayName: string;
  projectPath: string;
  projectName: string;
  gitRepoUrl?: string;
};

export type UserTagInfo = {
  tag: string;
  displayName: string;
  userName?: string;
  userEmail?: string;
};

/** Container tag prefix. opencode-mem used `opencode`; ndomo uses `ndomo`. */
const TAG_PREFIX = "ndomo";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function getGitEmail(): string | null {
  try {
    const email = execSync("git config user.email", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return email || null;
  } catch {
    return null;
  }
}

export function getGitName(): string | null {
  try {
    const name = execSync("git config user.name", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}

export function getGitRepoUrl(directory: string): string | null {
  try {
    const url = execSync("git config --get remote.origin.url", {
      encoding: "utf-8",
      cwd: directory,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

export function getGitCommonDir(directory: string): string | null {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      cwd: directory,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!commonDir) {
      return null;
    }
    const resolved = isAbsolute(commonDir)
      ? normalize(commonDir)
      : normalize(resolve(directory, commonDir));
    if (existsSync(resolved)) {
      return realpathSync(resolved);
    }
    return resolved;
  } catch {
    return null;
  }
}

export function getGitTopLevel(directory: string): string | null {
  try {
    const topLevel = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd: directory,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return topLevel || null;
  } catch {
    return null;
  }
}

export function getProjectRoot(directory: string): string {
  const commonDir = getGitCommonDir(directory);
  if (commonDir && basename(commonDir) === ".git") {
    return dirname(commonDir);
  }
  const topLevel = getGitTopLevel(directory);
  if (topLevel) {
    return topLevel;
  }
  return directory;
}

export function getProjectIdentity(directory: string): string {
  const commonDir = getGitCommonDir(directory);
  if (commonDir) {
    return `git-common:${commonDir}`;
  }
  const gitRepoUrl = getGitRepoUrl(directory);
  if (gitRepoUrl) {
    return `remote:${gitRepoUrl}`;
  }
  return `path:${normalize(directory)}`;
}

export function getProjectName(directory: string): string {
  const normalized = normalize(directory).replace(/\\/g, "/");
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  return parts[parts.length - 1] || directory;
}

export function getUserTagInfo(): UserTagInfo {
  const email = getGitEmail();
  const name = getGitName();
  if (email) {
    return {
      tag: `${TAG_PREFIX}_user_${sha256(email)}`,
      displayName: name || email,
      ...(name ? { userName: name } : {}),
      userEmail: email,
    };
  }
  const fallback = name || process.env.USER || process.env.USERNAME || "anonymous";
  return {
    tag: `${TAG_PREFIX}_user_${sha256(fallback)}`,
    displayName: fallback,
    userName: fallback,
  };
}

export function getProjectTagInfo(directory: string): ProjectTagInfo {
  const projectRoot = getProjectRoot(directory);
  const projectName = getProjectName(projectRoot);
  const gitRepoUrl = getGitRepoUrl(directory);
  const projectIdentity = getProjectIdentity(projectRoot);
  return {
    tag: `${TAG_PREFIX}_project_${sha256(projectIdentity)}`,
    displayName: projectRoot,
    projectPath: projectRoot,
    projectName,
    ...(gitRepoUrl ? { gitRepoUrl } : {}),
  };
}

export function getTags(directory: string): { user: UserTagInfo; project: ProjectTagInfo } {
  return {
    user: getUserTagInfo(),
    project: getProjectTagInfo(directory),
  };
}

/**
 * Tests for the one-shot opencode-mem → ndomo migration (src/mem/migrate.ts).
 *
 * Fixtures are miniature opencode-mem shards written to tmp dirs only; the real
 * `~/.opencode-mem` is never read or written.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mapContainerTag, migrateMemories, parseTagsCsv } from "./migrate.ts";
import { addMemory, openMemDb } from "./store.ts";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

type ShardRowInput = {
  id: string;
  content: string;
  container_tag: string;
  tags?: string | null;
  type?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  is_pinned?: number | null;
  metadata?: string | null;
  user_name?: string | null;
  user_email?: string | null;
  project_path?: string | null;
  project_name?: string | null;
  git_repo_url?: string | null;
};

/** Create a miniature opencode-mem shard DB with the real column set. */
function createShard(dir: string, name: string, rows: ShardRowInput[]): string {
  const path = join(dir, name);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      vector BLOB NOT NULL,
      tags_vector BLOB,
      container_tag TEXT NOT NULL,
      tags TEXT,
      type TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      metadata TEXT,
      display_name TEXT,
      user_name TEXT,
      user_email TEXT,
      project_path TEXT,
      project_name TEXT,
      git_repo_url TEXT,
      is_pinned INTEGER DEFAULT 0
    );
  `);
  const insert = db.query(`
    INSERT INTO memories (
      id, content, vector, tags_vector, container_tag, tags, type, created_at,
      updated_at, metadata, display_name, user_name, user_email, project_path,
      project_name, git_repo_url, is_pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.content,
      new Uint8Array([1, 2, 3]),
      null,
      row.container_tag,
      row.tags ?? null,
      row.type ?? null,
      row.created_at ?? null,
      row.updated_at ?? null,
      row.metadata ?? null,
      null,
      row.user_name ?? null,
      row.user_email ?? null,
      row.project_path ?? null,
      row.project_name ?? null,
      row.git_repo_url ?? null,
      row.is_pinned ?? 0,
    );
  }
  db.close();
  return path;
}

function targetPath(target: string, projectTag: string): string {
  return join(target, "projects", `${projectTag}.db`);
}

function countMemories(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

describe("mapContainerTag", () => {
  test("swaps the opencode_ prefix for ndomo_", () => {
    expect(mapContainerTag("opencode_project_abc")).toBe("ndomo_project_abc");
    expect(mapContainerTag("opencode_user_xyz")).toBe("ndomo_user_xyz");
  });

  test("leaves other tags untouched", () => {
    expect(mapContainerTag("ndomo_project_abc")).toBe("ndomo_project_abc");
    expect(mapContainerTag("custom")).toBe("custom");
  });
});

describe("parseTagsCsv", () => {
  test("parses plain CSV, trimming and deduping", () => {
    expect(parseTagsCsv("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseTagsCsv(" a , b , a ,, ")).toEqual(["a", "b"]);
  });

  test("parses a JSON array string", () => {
    expect(parseTagsCsv('["x","y","x"]')).toEqual(["x", "y"]);
  });

  test("returns [] for null/empty", () => {
    expect(parseTagsCsv(null)).toEqual([]);
    expect(parseTagsCsv("   ")).toEqual([]);
  });

  test("falls back to CSV when a JSON array string is malformed", () => {
    expect(parseTagsCsv('["broken",')).toEqual(['["broken"']);
  });
});

describe("migrateMemories — basic", () => {
  test("migrates rows, maps tags, preserves timestamps and records provenance", () => {
    const source = makeTmpDir("ndomo-mig-src-");
    const target = makeTmpDir("ndomo-mig-dst-");
    const shardName = "project_abc123_shard_0.db";
    createShard(source, shardName, [
      {
        id: "m1",
        content: "first memory",
        container_tag: "opencode_project_abc123",
        tags: "alpha,beta",
        type: "note",
        created_at: 1000,
        updated_at: 2000,
        is_pinned: 1,
        metadata: '{"origin":"x"}',
        user_name: "alice",
        user_email: "alice@example.com",
        project_path: "/proj",
        project_name: "proj",
        git_repo_url: "https://example.com/proj.git",
      },
      {
        id: "m2",
        content: "second memory",
        container_tag: "opencode_project_abc123",
        tags: '["gamma","delta"]',
        type: null,
        created_at: 3000,
        updated_at: 4000,
      },
      {
        id: "m3",
        content: "third memory",
        container_tag: "opencode_project_abc123",
        tags: null,
        type: "decision",
        created_at: 5000,
        updated_at: 5000,
      },
    ]);

    const report = migrateMemories({ source, target });

    expect(report.errors).toEqual([]);
    expect(report.migrated).toBe(3);
    expect(report.skipped).toBe(0);
    expect(report.projects).toHaveLength(1);
    expect(report.projects[0]?.shard).toBe(shardName);
    expect(report.projects[0]?.containerTag).toBe("opencode_project_abc123");
    expect(report.projects[0]?.projectTag).toBe("ndomo_project_abc123");

    const dbPath = targetPath(target, "ndomo_project_abc123");
    expect(existsSync(dbPath)).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.query("SELECT * FROM memories ORDER BY created_at").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(3);

      const m1 = rows.find((r) => r.id === "m1") as Record<string, unknown>;
      expect(m1.source).toBe("migration");
      expect(m1.project_tag).toBe("ndomo_project_abc123");
      expect(m1.created_at).toBe(1000);
      expect(m1.updated_at).toBe(2000);
      expect(m1.is_pinned).toBe(1);
      expect(m1.type).toBe("note");
      expect(m1.user_name).toBe("alice");
      expect(m1.project_name).toBe("proj");
      expect(m1.content_hash).toBe(createHash("sha256").update("first memory").digest("hex"));
      const m1meta = JSON.parse(m1.metadata as string) as Record<string, unknown>;
      expect(m1meta.origin).toBe("x");
      expect(m1meta.migratedFrom).toEqual({
        container_tag: "opencode_project_abc123",
        shard: basename(shardName),
      });

      const m2 = rows.find((r) => r.id === "m2") as Record<string, unknown>;
      expect(m2.type).toBe("note");

      const m3 = rows.find((r) => r.id === "m3") as Record<string, unknown>;
      expect(m3.type).toBe("decision");
      expect(m3.is_pinned).toBe(0);

      const m1tags = db
        .query("SELECT tag FROM memory_tags WHERE memory_id = 'm1' ORDER BY tag")
        .all() as Array<{ tag: string }>;
      expect(m1tags.map((r) => r.tag)).toEqual(["alpha", "beta"]);

      const m2tags = db
        .query("SELECT tag FROM memory_tags WHERE memory_id = 'm2' ORDER BY tag")
        .all() as Array<{ tag: string }>;
      expect(m2tags.map((r) => r.tag)).toEqual(["delta", "gamma"]);
    } finally {
      db.close();
    }
  });
});

describe("migrateMemories — idempotency", () => {
  test("a second run skips everything and does not change the total", () => {
    const source = makeTmpDir("ndomo-mig-src-");
    const target = makeTmpDir("ndomo-mig-dst-");
    createShard(source, "project_abc_shard_0.db", [
      { id: "a", content: "one", container_tag: "opencode_project_abc" },
      { id: "b", content: "two", container_tag: "opencode_project_abc" },
    ]);

    const first = migrateMemories({ source, target });
    expect(first.migrated).toBe(2);
    expect(first.skipped).toBe(0);

    const second = migrateMemories({ source, target });
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.errors).toEqual([]);
    expect(countMemories(targetPath(target, "ndomo_project_abc"))).toBe(2);
  });
});

describe("migrateMemories — dryRun", () => {
  test("counts migrations without creating or writing the target", () => {
    const source = makeTmpDir("ndomo-mig-src-");
    const target = makeTmpDir("ndomo-mig-dst-");
    createShard(source, "project_abc_shard_0.db", [
      { id: "a", content: "one", container_tag: "opencode_project_abc" },
      { id: "b", content: "two", container_tag: "opencode_project_abc" },
    ]);

    const report = migrateMemories({ source, target, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.migrated).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.errors).toEqual([]);
    expect(existsSync(targetPath(target, "ndomo_project_abc"))).toBe(false);
    expect(existsSync(join(target, "projects"))).toBe(false);
  });

  test("dedups against an existing target when dryRun", () => {
    const source = makeTmpDir("ndomo-mig-src-");
    const target = makeTmpDir("ndomo-mig-dst-");
    const projectTag = "ndomo_project_abc";
    const db = openMemDb(projectTag, target);
    try {
      addMemory(db, { content: "one", identity: { projectTag } });
    } finally {
      db.close();
    }
    createShard(source, "project_abc_shard_0.db", [
      { id: "a", content: "one", container_tag: "opencode_project_abc" },
      { id: "b", content: "two", container_tag: "opencode_project_abc" },
    ]);

    const report = migrateMemories({ source, target, dryRun: true });
    expect(report.migrated).toBe(1);
    expect(report.skipped).toBe(1);
    expect(countMemories(targetPath(target, projectTag))).toBe(1);
  });
});

describe("migrateMemories — dedup against existing target rows", () => {
  test("skips rows whose content already exists in the target", () => {
    const source = makeTmpDir("ndomo-mig-src-");
    const target = makeTmpDir("ndomo-mig-dst-");
    const projectTag = "ndomo_project_abc";
    const db = openMemDb(projectTag, target);
    try {
      addMemory(db, { content: "already here", identity: { projectTag } });
    } finally {
      db.close();
    }
    createShard(source, "project_abc_shard_0.db", [
      { id: "dup", content: "already here", container_tag: "opencode_project_abc" },
      { id: "new", content: "brand new", container_tag: "opencode_project_abc" },
    ]);

    const report = migrateMemories({ source, target });
    expect(report.migrated).toBe(1);
    expect(report.skipped).toBe(1);
    expect(countMemories(targetPath(target, projectTag))).toBe(2);
  });
});

describe("migrateMemories — multiple shards", () => {
  test("migrates distinct project shards into distinct target DBs", () => {
    const source = makeTmpDir("ndomo-mig-src-");
    const target = makeTmpDir("ndomo-mig-dst-");
    createShard(source, "project_one_shard_0.db", [
      { id: "a", content: "alpha", container_tag: "opencode_project_one" },
    ]);
    createShard(source, "project_two_shard_0.db", [
      { id: "b", content: "beta", container_tag: "opencode_project_two" },
    ]);

    const report = migrateMemories({ source, target });
    expect(report.migrated).toBe(2);
    expect(report.projects).toHaveLength(2);
    expect(existsSync(targetPath(target, "ndomo_project_one"))).toBe(true);
    expect(existsSync(targetPath(target, "ndomo_project_two"))).toBe(true);
  });
});

describe("migrateMemories — missing source", () => {
  test("reports an error instead of throwing", () => {
    const target = makeTmpDir("ndomo-mig-dst-");
    const missing = join(makeTmpDir("ndomo-mig-src-"), "does-not-exist");

    // A missing source must not throw — it returns a populated error report.
    const report = migrateMemories({ source: missing, target });

    expect(report.projects).toEqual([]);
    expect(report.migrated).toBe(0);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]).toContain("source not found");
  });
});

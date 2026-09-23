/**
 * Tests for the ndomo FlexSearch ranking layer (src/mem/search.ts).
 *
 * Each test gets an isolated storage root under a tmp dir. The in-process index
 * cache is cleared in beforeEach so a project tag reused across tests never
 * leaks a stale index.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSearchCache, indexMemory, removeFromIndex, searchMemories } from "./search.ts";
import type { MemRecord } from "./store.ts";
import { addMemory, openMemDb } from "./store.ts";

const PROJECT_A = "ndomo_project_searchaaaa0000";
const PROJECT_B = "ndomo_project_searchbbbb0000";

type SeedDoc = {
  content: string;
  type?: string;
  tags?: string[];
  pinned?: boolean;
  createdAt?: number;
};

function identityFor(projectTag: string) {
  return { projectTag, projectPath: "/tmp/proj", projectName: "proj" };
}

/** Insert docs into a project DB and return the persisted records. */
function seed(storagePath: string, projectTag: string, docs: SeedDoc[]): MemRecord[] {
  const db = openMemDb(projectTag, storagePath);
  const out: MemRecord[] = [];
  try {
    for (const doc of docs) {
      const { memory } = addMemory(db, {
        content: doc.content,
        identity: identityFor(projectTag),
        ...(doc.type !== undefined ? { type: doc.type } : {}),
        ...(doc.tags !== undefined ? { tags: doc.tags } : {}),
        ...(doc.pinned !== undefined ? { pinned: doc.pinned } : {}),
      });
      if (doc.createdAt !== undefined) {
        db.query("UPDATE memories SET created_at = ? WHERE id = ?").run(doc.createdAt, memory.id);
        out.push({ ...memory, createdAt: doc.createdAt });
      } else {
        out.push(memory);
      }
    }
  } finally {
    db.close();
  }
  return out;
}

let storagePath: string;

beforeEach(() => {
  clearSearchCache();
  storagePath = mkdtempSync(join(tmpdir(), "ndomo-mem-search-"));
});

afterEach(() => {
  rmSync(storagePath, { recursive: true, force: true });
});

describe("searchMemories multi-language", () => {
  test("finds the Spanish doc for a Spanish query and the English doc for an English query", () => {
    seed(storagePath, PROJECT_A, [
      { content: "La memoria del proyecto guarda decisiones importantes" },
      { content: "The project memory stores important decisions" },
    ]);

    const es = searchMemories(storagePath, PROJECT_A, "memoria");
    expect(es).toHaveLength(1);
    expect(es[0]?.content).toContain("memoria del proyecto");

    const en = searchMemories(storagePath, PROJECT_A, "memory");
    expect(en).toHaveLength(1);
    expect(en[0]?.content).toContain("project memory");
  });
});

describe("searchMemories ranking", () => {
  test("content matches rank before tag-only matches", () => {
    const [contentDoc, tagDoc] = seed(storagePath, PROJECT_A, [
      { content: "alpha keyword here", tags: ["misc"] },
      { content: "unrelated text", tags: ["keyword"] },
    ]);

    const results = searchMemories(storagePath, PROJECT_A, "keyword");
    expect(results.map((r) => r.id)).toEqual([contentDoc?.id ?? "", tagDoc?.id ?? ""]);
    expect(results[0]?.score).toBe(1);
    expect(results[1]?.score).toBe(0.5);
  });

  test("scores are deterministic and strictly decreasing by rank", () => {
    seed(storagePath, PROJECT_A, [
      { content: "sharedterm one" },
      { content: "sharedterm two" },
      { content: "sharedterm three" },
    ]);

    const results = searchMemories(storagePath, PROJECT_A, "sharedterm");
    expect(results).toHaveLength(3);
    for (let i = 0; i < results.length; i++) {
      expect(results[i]?.score).toBeCloseTo(1 / (i + 1), 10);
    }
  });
});

describe("searchMemories filters", () => {
  test("filters by type and by tag", () => {
    seed(storagePath, PROJECT_A, [
      { content: "sharedterm alpha", type: "note", tags: ["t1"] },
      { content: "sharedterm beta", type: "decision", tags: ["t1"] },
      { content: "sharedterm gamma", type: "note", tags: ["t2"] },
    ]);

    const byType = searchMemories(storagePath, PROJECT_A, "sharedterm", { type: "decision" });
    expect(byType).toHaveLength(1);
    expect(byType[0]?.content).toBe("sharedterm beta");

    const byTag = searchMemories(storagePath, PROJECT_A, "sharedterm", { tag: "t2" });
    expect(byTag).toHaveLength(1);
    expect(byTag[0]?.content).toBe("sharedterm gamma");
  });

  test("respects the limit", () => {
    seed(storagePath, PROJECT_A, [
      { content: "sharedterm one" },
      { content: "sharedterm two" },
      { content: "sharedterm three" },
    ]);

    expect(searchMemories(storagePath, PROJECT_A, "sharedterm", { limit: 2 })).toHaveLength(2);
  });
});

describe("searchMemories scope all-projects", () => {
  test("merges results from every project DB, score first then createdAt", () => {
    seed(storagePath, PROJECT_A, [{ content: "global term in project A", createdAt: 100 }]);
    seed(storagePath, PROJECT_B, [{ content: "global term in project B", createdAt: 200 }]);

    const results = searchMemories(storagePath, PROJECT_A, "global", { scope: "all-projects" });
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.projectTag))).toEqual(new Set([PROJECT_A, PROJECT_B]));

    // Both are rank 0 in their project (score 1); createdAt DESC breaks the tie.
    expect(results[0]?.projectTag).toBe(PROJECT_B);
    expect(results[1]?.projectTag).toBe(PROJECT_A);
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const cur = results[i];
      if (prev === undefined || cur === undefined) continue;
      expect(prev.score).toBeGreaterThanOrEqual(cur.score);
    }
  });
});

describe("searchMemories empty / no match", () => {
  test("returns [] for an empty index", () => {
    // openMemDb creates the project DB with no rows.
    openMemDb(PROJECT_A, storagePath).close();
    expect(searchMemories(storagePath, PROJECT_A, "anything")).toEqual([]);
  });

  test("returns [] when the query matches nothing", () => {
    seed(storagePath, PROJECT_A, [{ content: "some stored memory" }]);
    expect(searchMemories(storagePath, PROJECT_A, "zzznomatch")).toEqual([]);
  });

  test("returns [] for a blank query", () => {
    seed(storagePath, PROJECT_A, [{ content: "some stored memory" }]);
    expect(searchMemories(storagePath, PROJECT_A, "   ")).toEqual([]);
  });
});

describe("incremental index updates", () => {
  test("indexMemory makes a post-build memory searchable; removeFromIndex drops it", () => {
    seed(storagePath, PROJECT_A, [{ content: "first searchable memory" }]);
    expect(searchMemories(storagePath, PROJECT_A, "searchable")).toHaveLength(1);

    const db = openMemDb(PROJECT_A, storagePath);
    let added: MemRecord;
    try {
      added = addMemory(db, {
        content: "brandnew incremental token",
        identity: identityFor(PROJECT_A),
      }).memory;
    } finally {
      db.close();
    }

    // Not yet in the index -> not found.
    expect(searchMemories(storagePath, PROJECT_A, "incremental")).toEqual([]);

    indexMemory(storagePath, PROJECT_A, added);
    const found = searchMemories(storagePath, PROJECT_A, "incremental");
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(added.id);

    removeFromIndex(storagePath, PROJECT_A, added.id);
    expect(searchMemories(storagePath, PROJECT_A, "incremental")).toEqual([]);
  });

  test("removeFromIndex on an unbuilt index is a no-op", () => {
    expect(() => removeFromIndex(storagePath, PROJECT_A, "missing")).not.toThrow();
  });
});

describe("excerpt", () => {
  test("wraps the matched term and stays length-bounded", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(20);
    const content = `${filler}needle${filler}`;
    seed(storagePath, PROJECT_A, [{ content }]);

    const results = searchMemories(storagePath, PROJECT_A, "needle");
    expect(results).toHaveLength(1);
    const excerpt = results[0]?.excerpt ?? "";
    expect(excerpt.toLowerCase()).toContain("needle");
    expect(excerpt.length).toBeLessThanOrEqual(250);
  });

  test("falls back to a truncated prefix when the term only matches tags", () => {
    seed(storagePath, PROJECT_A, [{ content: "x".repeat(300), tags: ["needleonly"] }]);

    const results = searchMemories(storagePath, PROJECT_A, "needleonly");
    expect(results).toHaveLength(1);
    const excerpt = results[0]?.excerpt ?? "";
    expect(excerpt.length).toBe(161);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.toLowerCase()).not.toContain("needleonly");
  });
});

/**
 * Tests for the obsidian note renderers.
 *
 * Structure assertions per entity (managed frontmatter + markers + wiki-link
 * format), byte-exact goldens for one complete case per entity (inline string,
 * no file snapshots), YAML quoting, and the human-section contract:
 * extract → merge → resolveNoteContent (kind-change migration).
 *
 * All timestamps are fixed (`Date.UTC`) so every golden is byte-stable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "./fs.ts";
import {
  AUTO_END,
  AUTO_START,
  DEFAULT_HUMAN_SECTION,
  type DesignNoteInput,
  extractHumanSection,
  KIND_HINT,
  KIND_LABEL,
  type MemoryNoteInput,
  mergeNote,
  type PlanNoteInput,
  renderDesignNote,
  renderMemoryNote,
  renderPlanNote,
  renderTaskNote,
  resolveNoteContent,
  type TaskNoteInput,
} from "./render.ts";
import type { ObsidianKind } from "./types.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CREATED = Date.UTC(2026, 0, 2, 3, 4, 5);
const UPDATED = Date.UTC(2026, 0, 3, 6, 0, 0);
const COMPLETED = Date.UTC(2026, 0, 4, 9, 30, 0);

/** Raw project tag (kept verbatim in the frontmatter…). */
const TAG = "ndomo_project_abc123";
/** …while every wiki link uses the sanitized vault folder (see paths.ts). */
const VAULT_TAG = "ndomo-project-abc123";

const planInput: PlanNoteInput = {
  id: "plan-0001",
  slug: "ship-brain-layer",
  title: 'It\'s a "quoted" plan',
  status: "approved",
  priority: 2,
  kind: "feature",
  overview: "Project ndomo state into an external vault.",
  approach: "Deterministic render + idempotent write.",
  complexity: 3,
  createdAt: CREATED,
  updatedAt: UPDATED,
  approvedAt: CREATED,
  completedAt: null,
  projectTag: TAG,
  tasks: [
    {
      id: "task-2",
      orderIndex: 1,
      title: "Write sync state",
      description: "Write sync state",
      status: "pending",
      kind: "other",
      path: `Projects/${VAULT_TAG}/90-Other/ship-brain-layer__t01-task-2.md`,
    },
    {
      id: "task-1",
      orderIndex: 0,
      description: "Build the renderers",
      status: "done",
      kind: "feature",
      file: "ship-brain-layer__t00-task-1.md",
    },
  ],
};

const taskInput: TaskNoteInput = {
  id: "task-1",
  planId: "plan-0001",
  planSlug: "ship-brain-layer",
  orderIndex: 0,
  description: "Build the renderers",
  agent: "craftsman",
  status: "done",
  complexity: 2,
  result: "Renderers landed with tests.",
  error: null,
  files: ["src/obsidian/render.ts", "src/obsidian/render.test.ts"],
  kind: "feature",
  projectTag: TAG,
  createdAt: CREATED,
  completedAt: COMPLETED,
};

const designInput: DesignNoteInput = {
  id: "design-1",
  slug: "obsidian-brain-layer",
  title: "Obsidian Brain Layer",
  status: "decided",
  date: "2026-09-25",
  projectPath: "/home/tecnologia/ndomo-v2",
  sourceFilename: "2026-09-25-obsidian-brain-layer-design.md",
  sourcePath: ".ndomo/designs/2026-09-25-obsidian-brain-layer-design.md",
  body: "# Design: Obsidian Brain Layer\n\n## Problem\n\nNo human narrative interface.",
  kind: "design",
  projectTag: TAG,
};

const memoryInput: MemoryNoteInput = {
  id: "mem-1",
  content: "Vault is never a source of truth\nSQLite + embedded memory own transactions.",
  type: "design-decision",
  tags: ["obsidian", "vault", "  ", "idempotency"],
  source: "foreman",
  createdAt: CREATED,
  updatedAt: UPDATED,
  kind: "other",
  projectTag: TAG,
};

/** Human-owned tail used across the merge tests (must survive verbatim). */
const HUMAN_SECTION =
  "\n## Notas humanas\n\nHuman wrote **this** verbatim — see [[roadmap]].\n\n- keep me\n";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The `--- … ---` frontmatter block of a rendered note. */
function frontmatterOf(markdown: string): string {
  const end = markdown.indexOf("\n---\n", 4);
  expect(end).toBeGreaterThan(0);
  return markdown.slice(0, end + 5);
}

/** Assert every key appears (once, in this relative order) in the frontmatter. */
function expectKeyOrder(markdown: string, keys: readonly string[]): void {
  const frontmatter = frontmatterOf(markdown);
  let cursor = -1;
  for (const key of keys) {
    const at = frontmatter.indexOf(`\n${key}:`);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }
}

/** Assert a rendered note carries the managed block exactly once. */
function expectMarkers(markdown: string): void {
  expect(markdown).toContain(AUTO_START);
  expect(markdown).toContain(AUTO_END);
  expect(markdown.indexOf(AUTO_START)).toBeLessThan(markdown.indexOf(AUTO_END));
  expect(markdown.split(AUTO_START)).toHaveLength(2);
  expect(markdown.split(AUTO_END)).toHaveLength(2);
}

// ─── renderPlanNote ─────────────────────────────────────────────────────────

describe("renderPlanNote", () => {
  test("emits the managed frontmatter with a stable key order", () => {
    const { markdown } = renderPlanNote(planInput);
    expect(markdown.startsWith("---\n")).toBe(true);
    expect(frontmatterOf(markdown)).toContain("ndomoEntity: 'plan'");
    expect(frontmatterOf(markdown)).toContain("ndomoId: 'plan-0001'");
    expect(frontmatterOf(markdown)).toContain("ndomoKind: 'feature'");
    expect(frontmatterOf(markdown)).toContain(`ndomoProjectTag: '${TAG}'`);
    expectKeyOrder(markdown, [
      "ndomoEntity",
      "ndomoId",
      "ndomoKind",
      "ndomoProjectTag",
      "title",
      "status",
      "slug",
      "priority",
      "complexity",
      "createdAt",
      "updatedAt",
      "approvedAt",
    ]);
    expect(frontmatterOf(markdown)).not.toContain("completedAt");
  });

  test("quotes YAML safely (apostrophes → '', double quotes kept)", () => {
    const { markdown } = renderPlanNote(planInput);
    expect(frontmatterOf(markdown)).toContain(`title: 'It''s a "quoted" plan'`);
    const newlineTitle = renderPlanNote({ ...planInput, title: "line one\nline two" });
    expect(frontmatterOf(newlineTitle.markdown)).toContain("title: 'line one line two'");
    expect(frontmatterOf(newlineTitle.markdown)).not.toContain("\nline two");
  });

  test("links referenced tasks with the exact wiki format", () => {
    const { markdown } = renderPlanNote(planInput);
    // `file` falls back into the task's kind folder, `path` is used verbatim.
    expect(markdown).toContain(
      `- [[Projects/${VAULT_TAG}/20-Features/ship-brain-layer__t00-task-1|Build the renderers]] — \`done\``,
    );
    expect(markdown).toContain(
      `- [[Projects/${VAULT_TAG}/90-Other/ship-brain-layer__t01-task-2|Write sync state]] — \`pending\``,
    );
    expect(markdown).not.toContain(".md|");
    expect(markdown).toContain("## Tasks (2)");
  });

  test("renders tasks sorted by orderIndex, not by input order", () => {
    const { markdown } = renderPlanNote({
      ...planInput,
      tasks: [...(planInput.tasks ?? [])].reverse(),
    });
    expect(markdown.indexOf("t00-task-1")).toBeLessThan(markdown.indexOf("t01-task-2"));
  });

  test("kind overlay paints label + hint on the note", () => {
    const kinds: ObsidianKind[] = ["bugfix", "docs", "research", "other"];
    for (const kind of kinds) {
      const { markdown } = renderPlanNote({ ...planInput, kind });
      expect(markdown).toContain(`> **${KIND_LABEL[kind]}** — ${KIND_HINT[kind]}`);
      expect(frontmatterOf(markdown)).toContain(`ndomoKind: '${kind}'`);
    }
  });

  test("autoPayload excludes the human section and is hash-stable", () => {
    const first = renderPlanNote(planInput);
    const second = renderPlanNote(planInput);
    expect(first.autoPayload).not.toContain("## Notas humanas");
    expect(first.markdown).toBe(`${first.autoPayload}${DEFAULT_HUMAN_SECTION}`);
    expect(sha256Hex(first.autoPayload)).toBe(sha256Hex(second.autoPayload));
    expect(first.autoPayload.endsWith(AUTO_END)).toBe(true);
  });

  test("golden: complete plan note", () => {
    expect(renderPlanNote(planInput).markdown).toBe(`---
ndomoEntity: 'plan'
ndomoId: 'plan-0001'
ndomoKind: 'feature'
ndomoProjectTag: '${TAG}'
title: 'It''s a "quoted" plan'
status: 'approved'
slug: 'ship-brain-layer'
priority: 2
complexity: 3
createdAt: '2026-01-02T03:04:05.000Z'
updatedAt: '2026-01-03T06:00:00.000Z'
approvedAt: '2026-01-02T03:04:05.000Z'
---
%% ndomo:auto:start %%
# It's a "quoted" plan

> **Feature** — New capability work

- **Status:** \`approved\`
- **Priority:** \`2\`
- **Complexity:** \`3\`

## Overview

Project ndomo state into an external vault.

## Approach

Deterministic render + idempotent write.

## Tasks (2)

- [[Projects/${VAULT_TAG}/20-Features/ship-brain-layer__t00-task-1|Build the renderers]] — \`done\`
- [[Projects/${VAULT_TAG}/90-Other/ship-brain-layer__t01-task-2|Write sync state]] — \`pending\`
%% ndomo:auto:end %%
## Notas humanas

`);
  });
});

// ─── renderTaskNote ─────────────────────────────────────────────────────────

describe("renderTaskNote", () => {
  test("emits the managed frontmatter with a stable key order", () => {
    const { markdown } = renderTaskNote(taskInput);
    expectKeyOrder(markdown, [
      "ndomoEntity",
      "ndomoId",
      "ndomoKind",
      "ndomoProjectTag",
      "title",
      "status",
      "plan",
      "planId",
      "planSlug",
      "orderIndex",
      "complexity",
      "createdAt",
      "completedAt",
    ]);
    expect(frontmatterOf(markdown)).toContain("ndomoEntity: 'task'");
    expectMarkers(markdown);
  });

  test("links the parent plan in the frontmatter and in the body", () => {
    const { markdown } = renderTaskNote(taskInput);
    const link = `[[Projects/${VAULT_TAG}/10-Plans/ship-brain-layer|ship-brain-layer]]`;
    expect(frontmatterOf(markdown)).toContain(`plan: '${link}'`);
    expect(markdown).toContain(`- **Plan:** ${link}`);
    expect(markdown).not.toContain(".md|");
  });

  test("derives the title from the first line of the description", () => {
    const { markdown } = renderTaskNote({
      ...taskInput,
      description: "\n\n  First line is the title.\nSecond paragraph stays in the body.",
    });
    expect(frontmatterOf(markdown)).toContain("title: 'First line is the title.'");
    expect(markdown).toContain("## Description");
    expect(markdown).toContain("Second paragraph stays in the body.");
  });

  test("omits the Description section for single-line descriptions", () => {
    const { markdown } = renderTaskNote(taskInput);
    expect(markdown).not.toContain("## Description");
  });

  test("optional sections disappear when there is nothing to show", () => {
    const { markdown } = renderTaskNote({
      ...taskInput,
      agent: null,
      complexity: null,
      result: "",
      error: null,
      files: [],
      createdAt: null,
      completedAt: null,
    });
    expect(markdown).not.toContain("## Result");
    expect(markdown).not.toContain("## Files");
    expect(markdown).not.toContain("**Agent:**");
    expect(markdown).not.toContain("**Complexity:**");
    expect(frontmatterOf(markdown)).not.toContain("complexity:");
    expect(frontmatterOf(markdown)).not.toContain("createdAt:");
    expect(frontmatterOf(markdown)).toContain("planId:");
  });

  test("renders error and multi-line description sections when present", () => {
    const { markdown } = renderTaskNote({
      ...taskInput,
      description: "Step one\nStep two",
      error: "boom",
    });
    expect(markdown).toContain("## Description");
    expect(markdown).toContain("## Error");
    expect(markdown).toContain("boom");
  });

  test("golden: complete task note", () => {
    expect(renderTaskNote(taskInput).markdown).toBe(`---
ndomoEntity: 'task'
ndomoId: 'task-1'
ndomoKind: 'feature'
ndomoProjectTag: '${TAG}'
title: 'Build the renderers'
status: 'done'
plan: '[[Projects/${VAULT_TAG}/10-Plans/ship-brain-layer|ship-brain-layer]]'
planId: 'plan-0001'
planSlug: 'ship-brain-layer'
orderIndex: 0
complexity: 2
createdAt: '2026-01-02T03:04:05.000Z'
completedAt: '2026-01-04T09:30:00.000Z'
---
%% ndomo:auto:start %%
# Build the renderers

> **Feature** — New capability work

- **Status:** \`done\`
- **Plan:** [[Projects/${VAULT_TAG}/10-Plans/ship-brain-layer|ship-brain-layer]]
- **Order:** \`0\`
- **Agent:** \`craftsman\`
- **Complexity:** \`2\`

## Result

Renderers landed with tests.

## Files

- \`src/obsidian/render.ts\`
- \`src/obsidian/render.test.ts\`
%% ndomo:auto:end %%
## Notas humanas

`);
  });
});

// ─── renderDesignNote ───────────────────────────────────────────────────────

describe("renderDesignNote", () => {
  test("emits the managed frontmatter with sourcePath and date", () => {
    const { markdown } = renderDesignNote(designInput);
    expectKeyOrder(markdown, [
      "ndomoEntity",
      "ndomoId",
      "ndomoKind",
      "ndomoProjectTag",
      "title",
      "status",
      "slug",
      "sourcePath",
      "date",
    ]);
    expect(frontmatterOf(markdown)).toContain("sourcePath: '.ndomo/designs/");
    expect(frontmatterOf(markdown)).toContain("date: '2026-09-25'");
    expectMarkers(markdown);
    expect(markdown).toContain("## Content");
  });

  test("drops the status key when the design has none", () => {
    const { markdown } = renderDesignNote({ ...designInput, status: null });
    expect(frontmatterOf(markdown)).not.toContain("status:");
    expect(markdown).not.toContain("**Status:**");
    // Key order of the remaining keys is unchanged.
    expectKeyOrder(markdown, ["ndomoProjectTag", "title", "slug", "sourcePath", "date"]);
  });

  test("golden: complete design note", () => {
    expect(renderDesignNote(designInput).markdown).toBe(`---
ndomoEntity: 'design'
ndomoId: 'design-1'
ndomoKind: 'design'
ndomoProjectTag: '${TAG}'
title: 'Obsidian Brain Layer'
status: 'decided'
slug: 'obsidian-brain-layer'
sourcePath: '.ndomo/designs/2026-09-25-obsidian-brain-layer-design.md'
date: '2026-09-25'
---
%% ndomo:auto:start %%
# Obsidian Brain Layer

> **Design** — Architecture decision record

- **Date:** \`2026-09-25\`
- **Status:** \`decided\`
- **Repository:** \`/home/tecnologia/ndomo-v2\`
- **Source:** \`.ndomo/designs/2026-09-25-obsidian-brain-layer-design.md\`

## Content

# Design: Obsidian Brain Layer

## Problem

No human narrative interface.
%% ndomo:auto:end %%
## Notas humanas

`);
  });
});

// ─── renderMemoryNote ───────────────────────────────────────────────────────

describe("renderMemoryNote", () => {
  test("emits the managed frontmatter with tags as a YAML list", () => {
    const { markdown } = renderMemoryNote(memoryInput);
    expectKeyOrder(markdown, [
      "ndomoEntity",
      "ndomoId",
      "ndomoKind",
      "ndomoProjectTag",
      "title",
      "type",
      "tags",
      "source",
      "createdAt",
      "updatedAt",
    ]);
    expect(frontmatterOf(markdown)).toContain(
      "tags:\n  - 'obsidian'\n  - 'vault'\n  - 'idempotency'",
    );
    expectMarkers(markdown);
  });

  test("empty tag lists collapse to [] and blank tags are dropped", () => {
    expect(frontmatterOf(renderMemoryNote({ ...memoryInput, tags: [] }).markdown)).toContain(
      "tags: []",
    );
    const blank = renderMemoryNote({ ...memoryInput, tags: ["", "  "] });
    expect(frontmatterOf(blank.markdown)).toContain("tags: []");
    expect(blank.markdown).not.toContain("**Tags:**");
  });

  test("derives the title from the first line of the content", () => {
    const { markdown } = renderMemoryNote(memoryInput);
    expect(frontmatterOf(markdown)).toContain("title: 'Vault is never a source of truth'");
    expect(markdown).toContain("SQLite + embedded memory own transactions.");
  });

  test("golden: complete memory note", () => {
    expect(renderMemoryNote(memoryInput).markdown).toBe(`---
ndomoEntity: 'memory'
ndomoId: 'mem-1'
ndomoKind: 'other'
ndomoProjectTag: '${TAG}'
title: 'Vault is never a source of truth'
type: 'design-decision'
tags:
  - 'obsidian'
  - 'vault'
  - 'idempotency'
source: 'foreman'
createdAt: '2026-01-02T03:04:05.000Z'
updatedAt: '2026-01-03T06:00:00.000Z'
---
%% ndomo:auto:start %%
# Vault is never a source of truth

> **Other** — Unclassified work

- **Type:** \`design-decision\`
- **Tags:** \`obsidian\`, \`vault\`, \`idempotency\`
- **Source:** \`foreman\`
- **Created:** \`2026-01-02T03:04:05.000Z\`

## Content

Vault is never a source of truth
SQLite + embedded memory own transactions.
%% ndomo:auto:end %%
## Notas humanas

`);
  });
});

// ─── Marker safety ──────────────────────────────────────────────────────────

describe("marker safety", () => {
  test("input quoting a marker cannot smuggle one into the payload", () => {
    const hostile = `echoing ${AUTO_START} and ${AUTO_END}`;
    const notes = [
      renderPlanNote({ ...planInput, title: hostile, overview: hostile }),
      renderTaskNote({ ...taskInput, description: hostile, result: hostile }),
      renderDesignNote({ ...designInput, body: hostile }),
      renderMemoryNote({ ...memoryInput, content: hostile }),
    ];
    for (const note of notes) {
      expect(note.autoPayload.split(AUTO_START)).toHaveLength(2);
      expect(note.autoPayload.split(AUTO_END)).toHaveLength(2);
      // The quoted marker survives as a defused look-alike (nothing is lost).
      expect(note.autoPayload).toContain("%% ndomo:auto-start %%");
      expect(note.autoPayload).toContain("%% ndomo:auto-end %%");
      expect(extractHumanSection(`${note.autoPayload}${HUMAN_SECTION}`)).toBe(HUMAN_SECTION);
    }
  });
});

// ─── Human section: extract / merge ─────────────────────────────────────────

describe("extractHumanSection", () => {
  test("null note → the default human section", () => {
    expect(extractHumanSection(null)).toBe(DEFAULT_HUMAN_SECTION);
  });

  test("note without markers → the default human section", () => {
    expect(extractHumanSection("# Hand-written note\n\nFree text.\n")).toBe(DEFAULT_HUMAN_SECTION);
  });

  test("everything after AUTO_END (incl. the immediate newline) is verbatim", () => {
    const existing = `${AUTO_START}\ngenerated\n${AUTO_END}${HUMAN_SECTION}`;
    expect(extractHumanSection(existing)).toBe(HUMAN_SECTION);
  });

  test("human text pasted before the marker is dropped (markers own that region)", () => {
    const existing = `frontmatter\n${AUTO_START}\nstale generated\n${AUTO_END}tail`;
    expect(extractHumanSection(existing)).toBe("tail");
  });

  test("a marker literal inside the frontmatter is not mistaken for the real one", () => {
    const sneaky = renderPlanNote({ ...planInput, title: `before ${AUTO_END} after` });
    const existing = `${sneaky.autoPayload}${HUMAN_SECTION}`;
    expect(extractHumanSection(existing)).toBe(HUMAN_SECTION);
    expect(mergeNote(sneaky, existing)).toBe(existing);
  });

  test("markers without a frontmatter block are honored", () => {
    const existing = `# Free note\n${AUTO_START}\nbody\n${AUTO_END}${HUMAN_SECTION}`;
    expect(extractHumanSection(existing)).toBe(HUMAN_SECTION);
  });
});

describe("mergeNote", () => {
  const generated = renderPlanNote(planInput);

  test("without an existing note → the generated markdown", () => {
    expect(mergeNote(generated, null)).toBe(generated.markdown);
  });

  test("existing note without markers → fully regenerated markdown", () => {
    expect(mergeNote(generated, "# foreign note\n")).toBe(generated.markdown);
  });

  test("existing note with markers → human tail preserved verbatim", () => {
    const existing = `${generated.autoPayload}${HUMAN_SECTION}`;
    const merged = mergeNote(generated, existing);
    expect(merged).toBe(`${generated.autoPayload}${HUMAN_SECTION}`);
    expect(merged.endsWith(HUMAN_SECTION)).toBe(true);
  });

  test("re-export with changed data keeps the human text and refreshes the auto block", () => {
    const existing = `${generated.autoPayload}${HUMAN_SECTION}`;
    const changed = renderPlanNote({
      ...planInput,
      title: "Renamed plan",
      status: "completed",
      completedAt: UPDATED,
    });
    const merged = mergeNote(changed, existing);

    expect(merged.endsWith(HUMAN_SECTION)).toBe(true);
    expect(merged).toContain("title: 'Renamed plan'");
    expect(merged).toContain("status: 'completed'");
    expect(merged).toContain("completedAt: '2026-01-03T06:00:00.000Z'");
    expect(merged).not.toContain("title: 'It''s a \"quoted\" plan'");
    // Idempotent: merging the same pair twice yields the same bytes.
    expect(mergeNote(changed, merged)).toBe(merged);
  });

  test("human edits to the auto block are overwritten on the next export", () => {
    const tampered = `${generated.autoPayload.replace("## Overview", "## Hacked")}${HUMAN_SECTION}`;
    const merged = mergeNote(generated, tampered);
    expect(merged).toContain("## Overview");
    expect(merged).not.toContain("## Hacked");
    expect(merged.endsWith(HUMAN_SECTION)).toBe(true);
  });
});

// ─── resolveNoteContent (write + kind-change migration) ─────────────────────

describe("resolveNoteContent", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ndomo-obsidian-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("kind change migrates the note and carries the human section over", () => {
    const oldPath = join(tmp, "Projects", "tag", "30-Bugfixes", "plan-a.md");
    const newPath = join(tmp, "Projects", "tag", "70-Docs", "plan-a.md");
    mkdirSync(join(tmp, "Projects", "tag", "30-Bugfixes"), { recursive: true });
    writeFileSync(oldPath, `${renderPlanNote(planInput).autoPayload}${HUMAN_SECTION}`, "utf-8");

    const generated = renderPlanNote({ ...planInput, kind: "docs" });
    const result = resolveNoteContent({ vaultRoot: tmp, newPath, oldPath, generated });

    expect(result.migratedFrom).toBe(oldPath);
    expect(result.content).toBe(`${generated.autoPayload}${HUMAN_SECTION}`);
    expect(readFileSync(newPath, "utf-8")).toBe(result.content);
    expect(result.content).toContain("ndomoKind: 'docs'");
    expect(result.content).toContain("Human wrote **this** verbatim");
    expect(existsSync(oldPath)).toBe(false);
  });

  test("same path merges against the file currently on disk", () => {
    const path = join(tmp, "Projects", "tag", "10-Plans", "plan-a.md");
    mkdirSync(join(tmp, "Projects", "tag", "10-Plans"), { recursive: true });
    writeFileSync(path, `${renderPlanNote(planInput).autoPayload}${HUMAN_SECTION}`, "utf-8");

    const generated = renderPlanNote({ ...planInput, status: "executing" });
    const result = resolveNoteContent({ vaultRoot: tmp, newPath: path, oldPath: path, generated });

    expect(result.migratedFrom).toBeNull();
    expect(result.content).toContain("status: 'executing'");
    expect(result.content.endsWith(HUMAN_SECTION)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("fresh note (nothing on disk) writes the generated markdown", () => {
    const newPath = join(tmp, "Projects", "tag", "95-Memories", "mem.md");
    const generated = renderMemoryNote(memoryInput);
    const result = resolveNoteContent({ vaultRoot: tmp, newPath, oldPath: null, generated });

    expect(result.migratedFrom).toBeNull();
    expect(result.content).toBe(generated.markdown);
    expect(readFileSync(newPath, "utf-8")).toBe(generated.markdown);
  });

  test("a stale oldPath pointing at a missing file falls back to the new path", () => {
    const oldPath = join(tmp, "gone", "plan-a.md");
    const newPath = join(tmp, "here", "plan-a.md");
    const generated = renderPlanNote(planInput);
    mkdirSync(join(tmp, "here"), { recursive: true });
    writeFileSync(newPath, `${generated.autoPayload}${HUMAN_SECTION}`, "utf-8");

    const result = resolveNoteContent({ vaultRoot: tmp, newPath, oldPath, generated });
    expect(result.migratedFrom).toBeNull();
    expect(result.content.endsWith(HUMAN_SECTION)).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
  });

  // ── Contenimiento real (symlink escape) ────────────────────────────────────

  test("a note swapped for a symlink outside the vault is never read", () => {
    const vaultRoot = join(tmp, "vault");
    const secret = join(tmp, "outside", "secret.md");
    mkdirSync(dirname(secret), { recursive: true });
    writeFileSync(secret, "# SECRETO EXTERNO\ncontenido ajeno al vault\n", "utf-8");

    const newPath = join(vaultRoot, "Projects", "tag", "10-Plans", "plan-a.md");
    mkdirSync(dirname(newPath), { recursive: true });
    symlinkSync(secret, newPath);

    const generated = renderPlanNote(planInput);
    const result = resolveNoteContent({ vaultRoot, newPath, oldPath: null, generated });

    // El contenido externo NO se arrastra: gana la cola humana por defecto.
    expect(result.content).toBe(generated.markdown);
    expect(result.content).not.toContain("SECRETO EXTERNO");
    // rename(2) reemplaza el enlace por un fichero real dentro del vault.
    expect(readFileSync(newPath, "utf-8")).toBe(generated.markdown);
    // …y el fichero ajeno queda intacto.
    expect(readFileSync(secret, "utf-8")).toContain("SECRETO EXTERNO");
  });

  test("a kind-change oldPath symlinked outside the vault is neither read nor deleted", () => {
    const vaultRoot = join(tmp, "vault");
    const secret = join(tmp, "outside", "human.md");
    mkdirSync(dirname(secret), { recursive: true });
    writeFileSync(secret, "apunte privado del humano\n", "utf-8");

    const oldPath = join(vaultRoot, "Projects", "tag", "20-Features", "plan-a.md");
    mkdirSync(dirname(oldPath), { recursive: true });
    symlinkSync(secret, oldPath);
    const newPath = join(vaultRoot, "Projects", "tag", "70-Docs", "plan-a.md");

    const generated = renderPlanNote({ ...planInput, kind: "docs" });
    const result = resolveNoteContent({ vaultRoot, newPath, oldPath, generated });

    expect(result.migratedFrom).toBeNull();
    expect(result.content).toBe(generated.markdown);
    expect(result.content).not.toContain("apunte privado del humano");
    expect(existsSync(newPath)).toBe(true);
    // El enlace ajeno permanece: no leímos su destino, tampoco lo borramos.
    expect(existsSync(oldPath)).toBe(true);
    expect(readFileSync(secret, "utf-8")).toContain("apunte privado del humano");
  });
});

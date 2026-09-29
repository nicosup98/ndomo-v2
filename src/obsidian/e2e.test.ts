/**
 * ndomo obsidian — E2E suite: proyección cross-cutting + casos límite.
 *
 * Ejecuta los executors REALES (`obsidianExport` / `obsidianReadNote`) contra
 * una base de datos de proyecto real, la memoria embebida real y un vault real,
 * todos dentro de un único sandbox tmp. Sin registro de tools, sin snapshots de
 * archivo, sin red.
 *
 * Hermeticidad: `export.ts`/`read.ts` rootean el sync-state en
 * `process.env.HOME ?? os.homedir()` (Bun no honra un HOME mutado en
 * `os.homedir()`), así que `HOME`/`XDG_CONFIG_HOME` se reescriben al sandbox en
 * `beforeAll` y se restauran en `afterAll`. El último test verifica con el HOME
 * original que `~/.ndomo/obsidian` real jamás se creó y que el vault de pruebas
 * vive dentro del sandbox.
 *
 * Códigos de error cubiertos (9/9): NOT_CONFIGURED, DISABLED, INSIDE_REPO,
 * ENTITY_NOT_FOUND, SOURCE_NOT_FOUND, UNSAFE_PATH, INVALID_KIND,
 * VAULT_UNWRITABLE, IO_ERROR.
 *
 * Escenario 10 incluye el escape por SYMLINK (nota sustituida por un enlace
 * hacia un fichero externo → `UNSAFE_PATH` en la lectura por `path` y por la
 * sync-state), que es lo que garantiza que `readFileIfExists` nunca devuelva
 * contenido ajeno al vault.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/client.ts";
import { runMigrations } from "../db/migrations.ts";
import { createPlan, updatePlanFields } from "../db/plans.ts";
import { createTasksBatch, updateTaskFields } from "../db/tasks.ts";
import type { Plan, PlanTask } from "../db/types.ts";
import { addMemory, openMemDb } from "../mem/store.ts";
import { getProjectTagInfo } from "../mem/tags.ts";
import { type ExportDeps, type ExportRequest, obsidianExport } from "./export.ts";
import { sanitizeSegment } from "./paths.ts";
import { obsidianReadNote } from "./read.ts";
import type { ObsidianConfig, ObsidianEnvelope, ObsidianErrorCode } from "./types.ts";

// ─── Hermetic env (captured BEFORE the sandbox rewrites HOME) ────────────────

/** Real user home as seen at load time, before `beforeAll` mutates `HOME`. */
const REAL_HOME = process.env.HOME ?? homedir();
/** Whether the real `~/.ndomo/obsidian` pre-existed this suite. */
const REAL_OBSIDIAN_EXISTED = existsSync(join(REAL_HOME, ".ndomo", "obsidian"));
const PRIOR_ENV = {
  home: process.env.HOME,
  xdg: process.env.XDG_CONFIG_HOME,
};

function restoreEnv(key: "HOME" | "XDG_CONFIG_HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ─── Sandbox state ───────────────────────────────────────────────────────────

let sandbox: string;
/** Sandbox home — where `~/.ndomo/obsidian/…` must resolve during the suite. */
let home: string;
/** Shared external vault for every "happy path" scenario. */
let vault: string;

const openDatabases: Database[] = [];
/** Every project tag exercised, to assert the real home stayed untouched. */
const projectTags = new Set<string>();

// ─── Local helpers ───────────────────────────────────────────────────────────

type Project = {
  dir: string;
  db: Database;
  /** Raw `ndomo_project_<hash>` tag (frontmatter value). */
  tag: string;
  /** Sanitized tag — the actual vault / sync-state directory name. */
  ns: string;
  memStoragePath: string;
};

/** Isolated project inside the sandbox: own `state.db`, own sync-state tag. */
function makeProject(name: string): Project {
  const dir = join(sandbox, "projects", name);
  mkdirSync(dir, { recursive: true });
  const db = openDb(dir);
  runMigrations(db);
  openDatabases.push(db);
  const tag = getProjectTagInfo(dir).tag;
  projectTags.add(tag);
  return { dir, db, tag, ns: sanitizeSegment(tag), memStoragePath: join(sandbox, "mem") };
}

/** Vault config (enabled by default) with optional per-scenario overrides. */
function vaultConfig(vaultPath: string, overrides?: Partial<ObsidianConfig>): ObsidianConfig {
  return { enabled: true, vaultPath, allowInsideRepo: false, ...overrides };
}

/** Deps bundle for {@link obsidianExport}. */
function exportDeps(p: Project, config: ObsidianConfig): ExportDeps {
  return { db: p.db, projectDir: p.dir, memStoragePath: p.memStoragePath, config };
}

/** Deps bundle for {@link obsidianReadNote}. */
function readDeps(
  p: Project,
  config: ObsidianConfig,
): { config: ObsidianConfig; projectDir: string } {
  return { config, projectDir: p.dir };
}

/** Narrow a successful envelope to its data, or fail loudly with the error. */
function ok<T>(res: ObsidianEnvelope<T>): T {
  if (!res.ok) throw new Error(`expected ok envelope, got ${res.error.code}: ${res.error.message}`);
  return res.data;
}

/** Assert an error envelope with exactly `code` and return it. */
function err<T>(
  res: ObsidianEnvelope<T>,
  code: ObsidianErrorCode,
): { code: ObsidianErrorCode; message: string; hint?: string } {
  if (res.ok) throw new Error(`expected error ${code}, but the envelope was ok`);
  expect(res.error.code).toBe(code);
  return res.error;
}

/** Indexed access for test fixtures — throws instead of a `!` assertion. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture[${index}] missing in ${items.length}-item list`);
  return item;
}

/** UTF-8 read of an absolute note path. */
function readNote(absPath: string): string {
  return readFileSync(absPath, "utf-8");
}

/**
 * Append a human-owned line at the END of the note. `## Notas humanas` is the
 * last section of a freshly rendered note, so appending lands under it.
 */
function appendHuman(absPath: string, line: string): void {
  writeFileSync(absPath, `${readNote(absPath)}${line}\n`, "utf-8");
}

/** Seed a feature-category plan (kind resolves to `feature`). */
function seedPlan(p: Project, slug: string): Plan {
  return createPlan(p.db, {
    id: crypto.randomUUID(),
    slug,
    title: `Plan ${slug}`,
    status: "draft",
    priority: 2,
    approvedAt: null,
    completedAt: null,
    sessionId: null,
    overview: `Overview de ${slug}`,
    approach: null,
    complexity: 3,
    createdBy: "e2e",
    updatedBy: "e2e",
    sourceSessionId: null,
    sourceMessageId: null,
    category: "feature",
    metadata: {},
    archivedAt: null,
  });
}

/** Seed tasks (unique descriptions — the batch skips duplicate signatures). */
function seedTasks(p: Project, planId: string, descriptions: readonly string[]): PlanTask[] {
  return createTasksBatch(
    p.db,
    planId,
    descriptions.map((description) => ({ description, agent: "craftsman", createdBy: "e2e" })),
  );
}

/** Vault-relative note path of an item returned by an export. */
function noteAbs(item: { path: string }): string {
  return join(vault, item.path);
}

/** `Projects/<ns>/<folder>/<file>` expected for a note. */
function vaultPathOf(p: Project, folder: string, file: string): string {
  return `Projects/${p.ns}/${folder}/${file}`;
}

// ─── Suite-level setup / teardown ────────────────────────────────────────────

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "ndomo-obsidian-e2e-"));
  home = join(sandbox, "home");
  vault = join(sandbox, "vault");
  mkdirSync(home, { recursive: true });
  mkdirSync(vault, { recursive: true });
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(sandbox, "xdg");
});

afterAll(() => {
  for (const db of openDatabases) db.close();
  openDatabases.length = 0;
  rmSync(sandbox, { recursive: true, force: true });
  restoreEnv("HOME", PRIOR_ENV.home);
  restoreEnv("XDG_CONFIG_HOME", PRIOR_ENV.xdg);
});

// ─── 1 · Plan feature + scope=plan ───────────────────────────────────────────

describe("1 · export de plan feature", () => {
  test("10-Plans/<slug>.md con frontmatter plan/feature y tasks no archivadas a 20-Features", async () => {
    const p = makeProject("feature");
    const plan = seedPlan(p, "brain-layer");
    const tasks = seedTasks(p, plan.id, [
      "Implementar la proyección E2E",
      "Verificar idempotencia del hash",
      "Tarea archivada que no debe proyectarse",
    ]);
    expect(tasks).toHaveLength(3);
    const first = at(tasks, 0);
    const second = at(tasks, 1);
    const archived = at(tasks, 2);
    // No hay API pública de archivado de tasks — se siembra el estado directo.
    p.db.query("UPDATE plan_tasks SET archived_at = ? WHERE id = ?").run(Date.now(), archived.id);

    const data = ok(
      await obsidianExport(exportDeps(p, vaultConfig(vault)), {
        entityType: "plan",
        entityId: plan.id,
        scope: "plan",
      }),
    );

    expect(data.warning).toBe("sync-state missing");
    const t0File = `brain-layer__t00-${first.id.slice(0, 8)}.md`;
    const t1File = `brain-layer__t01-${second.id.slice(0, 8)}.md`;
    expect(data.items.map((item) => `${item.status} ${item.path}`)).toEqual([
      `exported ${vaultPathOf(p, "10-Plans", "brain-layer.md")}`,
      `exported ${vaultPathOf(p, "20-Features", t0File)}`,
      `exported ${vaultPathOf(p, "20-Features", t1File)}`,
    ]);
    expect(data.items.every((item) => item.kind === "feature")).toBe(true);

    const planNote = readNote(noteAbs(at(data.items, 0)));
    expect(planNote).toContain("ndomoEntity: 'plan'");
    expect(planNote).toContain("ndomoKind: 'feature'");
    expect(planNote).toContain(`ndomoProjectTag: '${p.tag}'`);
    expect(planNote).toContain("## Tasks (2)");
    expect(planNote).toContain(
      `[[${vaultPathOf(p, "20-Features", t0File.replace(/\.md$/, ""))}|Implementar la proyección E2E]]`,
    );

    const taskNote = readNote(noteAbs(at(data.items, 1)));
    expect(taskNote).toContain("ndomoEntity: 'task'");
    expect(taskNote).toContain("ndomoKind: 'feature'");
    expect(taskNote).toContain("planSlug: 'brain-layer'");
    expect(taskNote).toContain("## Notas humanas");

    expect(existsSync(noteAbs(at(data.items, 0)))).toBe(true);
    expect(
      existsSync(
        join(
          vault,
          vaultPathOf(p, "20-Features", `brain-layer__t02-${archived.id.slice(0, 8)}.md`),
        ),
      ),
    ).toBe(false);
  });
});

// ─── 2 · Override de kind ────────────────────────────────────────────────────

describe("2 · override de kind de una task a docs", () => {
  test("req.kind='docs' mueve la nota a 70-Docs", async () => {
    const p = makeProject("override-arg");
    const plan = seedPlan(p, "override-plan");
    const task = at(seedTasks(p, plan.id, ["Task con override por argumento"]), 0);

    const item = at(
      ok(
        await obsidianExport(exportDeps(p, vaultConfig(vault)), {
          entityType: "task",
          entityId: task.id,
          kind: "docs",
        }),
      ).items,
      0,
    );

    expect(item.kind).toBe("docs");
    expect(item.path).toBe(
      vaultPathOf(p, "70-Docs", `override-plan__t00-${task.id.slice(0, 8)}.md`),
    );
    expect(readNote(noteAbs(item))).toContain("ndomoKind: 'docs'");
    expect(
      existsSync(
        join(vault, vaultPathOf(p, "20-Features", `override-plan__t00-${task.id.slice(0, 8)}.md`)),
      ),
    ).toBe(false);
  });

  test("metadata.obsidianKind='docs' en DB también lleva la nota a 70-Docs", async () => {
    const p = makeProject("override-meta");
    const plan = seedPlan(p, "meta-plan");
    const task = at(seedTasks(p, plan.id, ["Task con override por metadata"]), 0);
    updateTaskFields(p.db, task.id, { metadata: { obsidianKind: "docs" } }, { updatedBy: "e2e" });

    const item = at(
      ok(
        await obsidianExport(exportDeps(p, vaultConfig(vault)), {
          entityType: "task",
          entityId: task.id,
        }),
      ).items,
      0,
    );

    expect(item.kind).toBe("docs");
    expect(item.path).toBe(vaultPathOf(p, "70-Docs", `meta-plan__t00-${task.id.slice(0, 8)}.md`));
    expect(readNote(noteAbs(item))).toContain("ndomoKind: 'docs'");
  });
});

// ─── 3 · Design ──────────────────────────────────────────────────────────────

describe("3 · export de design", () => {
  test("nota en 50-Designs con sourcePath en frontmatter y el cuerpo completo", async () => {
    const p = makeProject("design");
    const designsDir = join(p.dir, ".ndomo", "designs");
    mkdirSync(designsDir, { recursive: true });
    writeFileSync(
      join(designsDir, "2026-01-15-brain-design.md"),
      "# Brain design\n\nDecisión de arquitectura de la capa obsidian.\n",
      "utf-8",
    );

    const item = at(
      ok(
        await obsidianExport(exportDeps(p, vaultConfig(vault)), {
          entityType: "design",
          entityId: "2026-01-15-brain-design.md",
        }),
      ).items,
      0,
    );

    expect(item.kind).toBe("design");
    expect(item.path).toBe(vaultPathOf(p, "50-Designs", "2026-01-15-brain-design.md"));
    const note = readNote(noteAbs(item));
    expect(note).toContain("ndomoEntity: 'design'");
    expect(note).toContain("sourcePath: '.ndomo/designs/2026-01-15-brain-design.md'");
    expect(note).toContain("date: '2026-01-15'");
    expect(note).toContain("## Content");
    expect(note).toContain("Decisión de arquitectura de la capa obsidian.");
    // El artefacto original permanece en el repo (sincronización unidireccional).
    expect(existsSync(join(designsDir, "2026-01-15-brain-design.md"))).toBe(true);
  });

  test("el mismo design se resuelve también por slug", async () => {
    const p = makeProject("design-slug");
    const designsDir = join(p.dir, ".ndomo", "designs");
    mkdirSync(designsDir, { recursive: true });
    writeFileSync(
      join(designsDir, "2026-01-15-brain-design.md"),
      "# Brain design\n\nDecisión de arquitectura de la capa obsidian.\n",
      "utf-8",
    );
    const deps = exportDeps(p, vaultConfig(vault));

    const byFilename = at(
      ok(await obsidianExport(deps, { entityType: "design", entityId: "brain-design" })).items,
      0,
    );
    const bySlug = at(
      ok(await obsidianExport(deps, { entityType: "design", entityId: "brain" })).items,
      0,
    );

    expect(bySlug.kind).toBe("design");
    expect(bySlug.path).toBe(vaultPathOf(p, "50-Designs", "2026-01-15-brain-design.md"));
    expect(bySlug.path).toBe(byFilename.path);
    expect(readNote(noteAbs(bySlug))).toContain("## Content");
  });
});

// ─── 4 · Memory ──────────────────────────────────────────────────────────────

describe("4 · export de memory", () => {
  test("nota en 95-Memories/<content-slug>__<id8>.md", async () => {
    const p = makeProject("memory");
    const content = "Golden rule: always export after approving a plan";
    const memDb = openMemDb(p.tag, p.memStoragePath);
    const { memory } = addMemory(memDb, {
      content,
      type: "note",
      tags: ["e2e"],
      source: "manual",
      identity: { projectTag: p.tag, projectPath: p.dir, projectName: "e2e" },
    });
    memDb.close();

    const item = at(
      ok(
        await obsidianExport(exportDeps(p, vaultConfig(vault)), {
          entityType: "memory",
          entityId: memory.id,
        }),
      ).items,
      0,
    );

    expect(item.kind).toBe("other");
    expect(item.path).toBe(
      vaultPathOf(
        p,
        "95-Memories",
        `golden-rule-always-export-after-approving__${memory.id.slice(0, 8)}.md`,
      ),
    );
    const note = readNote(noteAbs(item));
    expect(note).toContain("ndomoEntity: 'memory'");
    expect(note).toContain("## Content");
    expect(note).toContain(content);
  });
});

// ─── 5 + 11 · Edición humana y lectura ───────────────────────────────────────

describe("5/11 · preservación de la sección humana", () => {
  test("re-export con datos CAMBIADOS conserva el texto humano y actualiza el bloque auto", async () => {
    const p = makeProject("human");
    const plan = seedPlan(p, "human-plan");
    const first = at(
      ok(
        await obsidianExport(exportDeps(p, vaultConfig(vault)), {
          entityType: "plan",
          entityId: plan.id,
        }),
      ).items,
      0,
    );
    const abs = noteAbs(first);
    appendHuman(abs, "Decisión del revisor: mantener el orden alfabético.");

    updatePlanFields(p.db, plan.id, { title: "Título reescrito en la DB" }, { updatedBy: "e2e" });

    const second = at(
      ok(
        await obsidianExport(exportDeps(p, vaultConfig(vault)), {
          entityType: "plan",
          entityId: plan.id,
        }),
      ).items,
      0,
    );
    expect(second.status).toBe("exported");
    expect(second.path).toBe(first.path);

    const after = readNote(abs);
    expect(after).toContain("Decisión del revisor: mantener el orden alfabético.");
    expect(after).toContain("title: 'Título reescrito en la DB'");
    expect(after).toContain("# Título reescrito en la DB");
    expect(after).not.toContain("Plan human-plan");
    expect(after.split("%% ndomo:auto:start %%")).toHaveLength(2);
  });

  test("11 · obsidian_read_note devuelve la sección humana (por entidad y por path)", async () => {
    const p = makeProject("read");
    const plan = seedPlan(p, "read-plan");
    const exported = at(
      ok(
        await obsidianExport(exportDeps(p, vaultConfig(vault)), {
          entityType: "plan",
          entityId: plan.id,
        }),
      ).items,
      0,
    );
    appendHuman(noteAbs(exported), "Apunte del revisor: enlazar con ADR-010.");

    const byEntity = ok(
      await obsidianReadNote(readDeps(p, vaultConfig(vault)), {
        entityType: "plan",
        entityId: plan.id,
      }),
    );
    expect(byEntity.path).toBe(vaultPathOf(p, "10-Plans", "read-plan.md"));
    expect(byEntity.markdown).toContain("Apunte del revisor: enlazar con ADR-010.");
    expect(byEntity.markdown).toContain("ndomoEntity: 'plan'");

    const byPath = ok(
      await obsidianReadNote(readDeps(p, vaultConfig(vault)), { path: byEntity.path }),
    );
    expect(byPath.markdown).toBe(byEntity.markdown);
  });
});

// ─── 6 · Idempotencia por hash ───────────────────────────────────────────────

describe("6 · idempotencia", () => {
  test("sin cambios de datos → items skipped y bytes idénticos", async () => {
    const p = makeProject("hash");
    const plan = seedPlan(p, "hash-plan");
    seedTasks(p, plan.id, ["Task estable que no cambia"]);
    const deps = exportDeps(p, vaultConfig(vault));
    const request: ExportRequest = { entityType: "plan", entityId: plan.id, scope: "plan" };

    const first = ok(await obsidianExport(deps, request));
    expect(first.items.every((item) => item.status === "exported")).toBe(true);
    const before = first.items.map((item) => readNote(noteAbs(item)));

    const second = ok(await obsidianExport(deps, request));
    expect(second.warning).toBeNull();
    expect(second.items.map((item) => item.status)).toEqual(["skipped", "skipped"]);
    const after = second.items.map((item) => readNote(noteAbs(item)));
    expect(after).toEqual(before);
  });
});

// ─── 12 · Migración de path por cambio de kind ───────────────────────────────

describe("12 · migración de path al cambiar kind", () => {
  test("arrastra la sección humana a 70-Docs y elimina el archivo viejo de 20-Features", async () => {
    const p = makeProject("migrate");
    const plan = seedPlan(p, "migrate-plan");
    const task = at(seedTasks(p, plan.id, ["Task que cambia de kind"]), 0);
    const deps = exportDeps(p, vaultConfig(vault));

    const before = at(
      ok(await obsidianExport(deps, { entityType: "task", entityId: task.id })).items,
      0,
    );
    expect(before.kind).toBe("feature");
    expect(before.path).toBe(
      vaultPathOf(p, "20-Features", `migrate-plan__t00-${task.id.slice(0, 8)}.md`),
    );
    appendHuman(noteAbs(before), "Notas del humano en la carpeta antigua.");

    updateTaskFields(p.db, task.id, { metadata: { obsidianKind: "docs" } }, { updatedBy: "e2e" });

    const after = at(
      ok(await obsidianExport(deps, { entityType: "task", entityId: task.id })).items,
      0,
    );
    expect(after.kind).toBe("docs");
    expect(after.status).toBe("exported");
    expect(after.path).toBe(
      vaultPathOf(p, "70-Docs", `migrate-plan__t00-${task.id.slice(0, 8)}.md`),
    );
    expect(after.path).not.toBe(before.path);
    expect(existsSync(join(vault, before.path))).toBe(false);

    const migrated = readNote(noteAbs(after));
    expect(migrated).toContain("Notas del humano en la carpeta antigua.");
    expect(migrated).toContain("ndomoKind: 'docs'");
    expect(migrated).toContain("## Notas humanas");
  });
});

// ─── 7-9 · Config: guard inside-repo / NOT_CONFIGURED / DISABLED ─────────────

describe("7-9 · configuración del vault", () => {
  test("7 · vaultPath dentro del repo → INSIDE_REPO; allowInsideRepo:true lo levanta", async () => {
    const p = makeProject("guard");
    const plan = seedPlan(p, "guard-plan");
    const inside = join(p.dir, "vault-interno");

    err(
      await obsidianExport(exportDeps(p, vaultConfig(inside)), {
        entityType: "plan",
        entityId: plan.id,
      }),
      "INSIDE_REPO",
    );
    expect(existsSync(inside)).toBe(false);

    ok(
      await obsidianExport(exportDeps(p, vaultConfig(inside, { allowInsideRepo: true })), {
        entityType: "plan",
        entityId: plan.id,
      }),
    );
    expect(existsSync(join(inside, "Projects", p.ns, "10-Plans", "guard-plan.md"))).toBe(true);
  });

  test("8 · vaultPath vacío → NOT_CONFIGURED (nada se resuelve ni se escribe)", async () => {
    const p = makeProject("not-configured");

    err(
      await obsidianExport(exportDeps(p, vaultConfig("")), {
        entityType: "plan",
        entityId: "plan_x",
      }),
      "NOT_CONFIGURED",
    );
    err(await obsidianReadNote(readDeps(p, vaultConfig("")), { path: "x.md" }), "NOT_CONFIGURED");
    expect(existsSync(join(home, ".ndomo", "obsidian", "projects", p.ns))).toBe(false);
  });

  test("9 · enabled=false → DISABLED en export y en read", async () => {
    const p = makeProject("disabled");
    const off = vaultConfig(join(sandbox, "vault-disabled"), { enabled: false });

    err(
      await obsidianExport(exportDeps(p, off), { entityType: "plan", entityId: "plan_x" }),
      "DISABLED",
    );
    err(await obsidianReadNote(readDeps(p, off), { path: "x.md" }), "DISABLED");
    expect(existsSync(join(sandbox, "vault-disabled"))).toBe(false);
  });
});

// ─── 10 · Traversal / paths inseguros ────────────────────────────────────────

describe("10 · traversal rechazado", () => {
  test("read_note rechaza .., backslash y rutas absolutas con UNSAFE_PATH", async () => {
    const p = makeProject("traversal");
    const cfg = vaultConfig(vault);
    for (const path of ["../../etc/passwd", "..\\..\\x", "/etc/passwd", "a/../../b"]) {
      err(await obsidianReadNote(readDeps(p, cfg), { path }), "UNSAFE_PATH");
    }
  });

  test("design con entityId='../../etc/passwd' → SOURCE_NOT_FOUND (no escapa)", async () => {
    const p = makeProject("traversal-design");
    const error = err(
      await obsidianExport(exportDeps(p, vaultConfig(vault)), {
        entityType: "design",
        entityId: "../../etc/passwd",
      }),
      "SOURCE_NOT_FOUND",
    );
    expect(error.message).toContain("../../etc/passwd");
    expect(existsSync(join(p.dir, ".ndomo", "designs", "passwd"))).toBe(false);
  });

  test("vaultPath relativo → UNSAFE_PATH y no materializa nada en el CWD", async () => {
    const p = makeProject("traversal-vault");
    const plan = seedPlan(p, "rel-plan");
    const cwdVault = join(process.cwd(), "vault-rel");

    err(
      await obsidianExport(exportDeps(p, vaultConfig("vault-rel")), {
        entityType: "plan",
        entityId: plan.id,
      }),
      "UNSAFE_PATH",
    );
    err(
      await obsidianReadNote(readDeps(p, vaultConfig("vault-rel")), { path: "x.md" }),
      "UNSAFE_PATH",
    );
    expect(existsSync(cwdVault)).toBe(false);
  });

  test("nota reemplazada por un symlink hacia fuera del vault → UNSAFE_PATH (read)", async () => {
    const p = makeProject("symlink-escape");
    const plan = seedPlan(p, "symlink-plan");
    const cfg = vaultConfig(vault);
    const item = at(
      ok(await obsidianExport(exportDeps(p, cfg), { entityType: "plan", entityId: plan.id })).items,
      0,
    );

    // Un fichero ajeno al vault que jamás debe devolverse.
    const outside = join(sandbox, "outside-secret.md");
    writeFileSync(outside, "SECRETO DEL HOST que no debe filtrarse\n", "utf-8");
    const absNote = join(vault, item.path);
    rmSync(absNote, { force: true });
    symlinkSync(outside, absNote);

    const byPath = await obsidianReadNote(readDeps(p, cfg), { path: item.path });
    expect(err(byPath, "UNSAFE_PATH").message).toContain("resolves outside the vault");

    const byEntity = await obsidianReadNote(readDeps(p, cfg), {
      entityType: "plan",
      entityId: plan.id,
    });
    expect(err(byEntity, "UNSAFE_PATH").message).toContain("outside the vault");

    // Ni el mensaje ni (hipotéticamente) los datos arrastran el contenido ajeno.
    expect(JSON.stringify(byPath)).not.toContain("SECRETO DEL HOST");
    expect(JSON.stringify(byEntity)).not.toContain("SECRETO DEL HOST");
    expect(readFileSync(outside, "utf-8")).toContain("SECRETO DEL HOST");
  });
});

// ─── 14 · ENTITY_NOT_FOUND / VAULT_UNWRITABLE / IO_ERROR ────────────────────

describe("14 · errores de entidades y de IO", () => {
  test("ids inexistentes → ENTITY_NOT_FOUND (plan, task y memory)", async () => {
    const p = makeProject("missing");
    const cfg = vaultConfig(vault);
    err(
      await obsidianExport(exportDeps(p, cfg), { entityType: "plan", entityId: "plan_ausente" }),
      "ENTITY_NOT_FOUND",
    );
    err(
      await obsidianExport(exportDeps(p, cfg), { entityType: "task", entityId: "task_ausente" }),
      "ENTITY_NOT_FOUND",
    );
    err(
      await obsidianExport(exportDeps(p, cfg), { entityType: "memory", entityId: "mem_ausente" }),
      "ENTITY_NOT_FOUND",
    );
    err(
      await obsidianReadNote(readDeps(p, cfg), { entityType: "plan", entityId: "plan_ausente" }),
      "ENTITY_NOT_FOUND",
    );
  });

  test("vaultPath cuyo padre es un ARCHIVO → VAULT_UNWRITABLE (ENOTDIR determinista)", async () => {
    const p = makeProject("unwritable");
    const blocker = join(sandbox, "blocker.txt");
    writeFileSync(blocker, "soy un archivo, no un directorio", "utf-8");
    const plan = seedPlan(p, "unwritable-plan");

    const error = err(
      await obsidianExport(exportDeps(p, vaultConfig(join(blocker, "vault"))), {
        entityType: "plan",
        entityId: plan.id,
      }),
      "VAULT_UNWRITABLE",
    );
    expect(error.message).toContain("blocker.txt");
    expect(existsSync(join(blocker, "vault"))).toBe(false);
  });

  test("read_note sin argumentos y scope=plan con entityType≠plan → IO_ERROR", async () => {
    const p = makeProject("io-error");
    const cfg = vaultConfig(vault);

    const empty = err(await obsidianReadNote(readDeps(p, cfg), {}), "IO_ERROR");
    expect(empty.message).toContain("path or entityType+entityId");

    err(
      await obsidianExport(exportDeps(p, cfg), {
        entityType: "task",
        entityId: "task_x",
        scope: "plan",
      }),
      "IO_ERROR",
    );
    err(
      await obsidianExport(exportDeps(p, cfg), {
        entityType: "design",
        entityId: "x",
        scope: "plan",
      }),
      "IO_ERROR",
    );
  });
});

// ─── 15 · INVALID_KIND ───────────────────────────────────────────────────────

describe("15 · kind override inválido", () => {
  test("kind='banana' → INVALID_KIND sin escribir nada", async () => {
    const p = makeProject("invalid-kind");
    const plan = seedPlan(p, "kind-plan");

    const error = err(
      await obsidianExport(exportDeps(p, vaultConfig(vault)), {
        entityType: "plan",
        entityId: plan.id,
        kind: "banana",
      }),
      "INVALID_KIND",
    );
    expect(error.message).toContain("banana");
    expect(error.hint).toContain("feature");
    expect(existsSync(join(vault, vaultPathOf(p, "10-Plans", "kind-plan.md")))).toBe(false);
  });
});

// ─── 13 · Namespace multi-proyecto ───────────────────────────────────────────

describe("13 · namespace multi-proyecto", () => {
  test("dos projectDirs con tags distintos comparten vault sin pisarse", async () => {
    const a = makeProject("multi-a");
    const b = makeProject("multi-b");
    expect(a.tag).not.toBe(b.tag);
    expect(a.ns).not.toBe(b.ns);
    const shared = vaultConfig(vault);

    const planA = seedPlan(a, "alpha-plan");
    const planB = seedPlan(b, "beta-plan");
    const itemA = at(
      ok(await obsidianExport(exportDeps(a, shared), { entityType: "plan", entityId: planA.id }))
        .items,
      0,
    );
    const itemB = at(
      ok(await obsidianExport(exportDeps(b, shared), { entityType: "plan", entityId: planB.id }))
        .items,
      0,
    );

    expect(itemA.path).toBe(vaultPathOf(a, "10-Plans", "alpha-plan.md"));
    expect(itemB.path).toBe(vaultPathOf(b, "10-Plans", "beta-plan.md"));
    expect(readNote(noteAbs(itemA))).toContain(`ndomoProjectTag: '${a.tag}'`);
    expect(readNote(noteAbs(itemB))).toContain(`ndomoProjectTag: '${b.tag}'`);

    // Sync-state separado por tag bajo el HOME sandboxeado.
    expect(existsSync(join(home, ".ndomo", "obsidian", "projects", a.ns, "sync-state.json"))).toBe(
      true,
    );
    expect(existsSync(join(home, ".ndomo", "obsidian", "projects", b.ns, "sync-state.json"))).toBe(
      true,
    );
  });
});

// ─── Hermeticidad ────────────────────────────────────────────────────────────

test("hermeticidad: el ~/.ndomo/obsidian real del usuario no se creó y el vault vive en el sandbox", () => {
  for (const tag of projectTags) {
    expect(
      existsSync(join(REAL_HOME, ".ndomo", "obsidian", "projects", sanitizeSegment(tag))),
    ).toBe(false);
  }
  if (!REAL_OBSIDIAN_EXISTED) {
    expect(existsSync(join(REAL_HOME, ".ndomo", "obsidian"))).toBe(false);
  }
  // El sync-state de la suite sí está bajo el HOME sandboxeado…
  expect(existsSync(join(home, ".ndomo", "obsidian", "projects"))).toBe(true);
  // …y el vault de pruebas es un directorio tmp, nunca el real.
  expect(vault.startsWith(sandbox)).toBe(true);
  expect(existsSync(join(vault, "Projects"))).toBe(true);
});

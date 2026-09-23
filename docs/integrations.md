# Integration Guide

## Embedded Memory (built-in)

ndomo ships its own persistent memory system — no external service required. It embeds
**bun:sqlite** (one database per project, WAL mode) as the source of truth and
**FlexSearch** (in-process, per-project document index) for full-text ranking.
There is no web UI and no separate daemon — everything runs inside the plugin process.

### What it is

ndomo memory stores and retrieves developer knowledge across sessions. Every agent can
store and search memories before planning or executing tasks. Dedup is exact: re-adding
the same text returns the existing record (`content_hash` = sha256 of trimmed content).

### How ndomo uses it

Agents consult memory before planning or exploring:

1. **Project search** — `mem_search({query, scope: "project"})` retrieves past decisions from the current project.
2. **Cross-project search** — `mem_search({query, scope: "all-projects"})` retrieves knowledge from all projects.
3. **Compressed storage** — before calling `mem_add`, ndomo compresses content with caveman regex patterns (`memory_compress`, 0 LLM tokens).

### Storage layout

| Path | Purpose |
|---|---|
| `~/.ndomo/mem/projects/<projectTag>.db` | One SQLite DB per project (WAL). Tables: `memories`, `memory_tags`, `schema_version` |
| `~/.ndomo/mem/` | Storage root; configurable via `mem.storagePath` or the `NDOMO_MEM_STORAGE_PATH` env var |

Project identity tags (`ndomo_project_<sha256(...).slice(0,16)>`) are derived from the
git common dir → remote URL → normalized path, in that order of precedence; user tags
(`ndomo_user_<sha256(email)>`) from the git email. The same project always resolves to
the same DB regardless of the working directory.

### Tool usage

| Tool | Call | Purpose |
|---|---|---|
| add | `mem_add({content, type?, tags?, pinned?})` | Store a memory; returns `{id, deduplicated, projectTag}` |
| search | `mem_search({query, scope?, type?, tag?, limit?})` | Ranked full-text search; returns `{results, count, scope}` with `score` + `excerpt` |
| list | `mem_list({scope?, type?, tag?, limit?, offset?})` | List memories (pinned first, newest first) |
| forget | `mem_forget({id})` | Delete a memory by id |
| stats | `mem_stats({scope?})` | Aggregate stats: `{total, byType, byTag, pinned, oldest, newest}` |
| compress | `memory_compress({text})` | Pre-storage caveman compression (regex, 0 LLM tokens) |

`scope` is `"project"` (default) or `"all-projects"`. Ranking uses FlexSearch over
content/tags/type fields; the excerpt is ±80 chars around the first query term and the
index is rebuilt lazily from SQLite per process — deliberately not persisted.

### Migration from legacy shards

If you used the previous memory backend, run the one-shot migration:

```bash
bun scripts/migrate-memory.ts [--dry-run] [--source <dir>] [--target <dir>]
```

Defaults: `--source ~/.opencode-mem/data/projects`, `--target ~/.ndomo/mem`.
Idempotent (dedup by `content_hash`); the legacy `opencode_` tag prefix is remapped to
`ndomo_` and provenance is recorded in `metadata.migratedFrom`. Prints a JSON report
`{source, target, dryRun, projects, migrated, skipped, errors}`; exits 1 if any errors.

### Config

See [configuration.md](configuration.md#memory-config) for memory settings
(`storagePath`, `defaultScope`, `autoCaptureEnabled`, `cavemanCompress`).

## DCP (optional)

Dynamic Context Pruning (`@tarquinen/opencode-dcp`) is an optional plugin that compresses conversation context by removing low-value tool outputs while preserving critical information.

**License:** AGPL-3.0

### What it is

DCP monitors context token usage and, on request or automatically, prunes low-value content from the conversation window. This extends session life in long-running tasks.

### How to install

```bash
bunx ndomo install --with-dcp
```

This installs `@tarquinen/opencode-dcp` as an optional peer dependency.

### How ndomo uses it

The foreman monitors context size:

- **~50k tokens** (foreman `minContextLimit`) — suggests `/dcp-compress` to the user.
- **~100k tokens** (foreman `maxContextLimit`) — invokes `compress` tool automatically at a natural pause point.
- **If DCP not installed** — falls back to native OpenCode context compaction.

### Context thresholds

Per-agent thresholds in `dcp_overrides` (only when DCP installed):

| Agent | minContextLimit | maxContextLimit |
|---|---|---|
| scout | 30,000 | 80,000 |
| scribe | 30,000 | 80,000 |
| foreman | 50,000 | 100,000 |
| sage | 50,000 | 100,000 |
| guild | 50,000 | 100,000 |
| inspector | 40,000 | 90,000 |

Agents without overrides use DCP defaults.

### Protected tools

The `compress` tool is listed in `protectedTools` — it cannot be pruned from context or disabled by subagents. This ensures DCP can always function when needed.

## Caveman + Memory

Memories are compressed before storage using regex-based caveman compression (`src/orchestrator/memory-hook.ts`).

### Compression rules

- **Protected:** Fenced code blocks (`` ``` ``), URLs (http, https, git, ssh).
- **Removed:** Articles (a, an, the, el, la, los, las, un, una), filler words (just, really, basically, actually, simply, etc.), leading conjunctions (and, but, or, so, then, also), filler phrases ("in order to", "it is important to note that", etc.), excess whitespace.

### Regex-only

All compression is regex-based — zero LLM tokens consumed for compression. The `COMPRESSION_PATTERNS` array in `memory-hook.ts` defines all patterns, applied sequentially.

### Limitations

- **Non-English text:** Spanish articles (el, la, los, las, un, una, unos, unas) are included in the pattern set. Other languages are not explicitly handled — their articles and fillers may survive compression.
- **Bilingual content:** Mixed-language content is compressed with English + Spanish rules only. Additional languages may require new patterns in `COMPRESSION_PATTERNS`.
- **Preserved content:** Code blocks and URLs are always preserved verbatim, even if they contain patterns that would otherwise be stripped.

## Troubleshooting

### Memory DB not found / empty search results

Memories live in `~/.ndomo/mem/projects/*.db`. If `mem_search` returns nothing:

1. Verify the storage path: `mem.storagePath` in `ndomo.json`, or the `NDOMO_MEM_STORAGE_PATH` env var.
2. Check the DB exists: `ls ~/.ndomo/mem/projects/` (one file per project tag).
3. The FlexSearch index rebuilds lazily on first search — a fresh process picks up rows written by a previous one automatically.
4. No migration needed for new installs; run `bun scripts/migrate-memory.ts` only if you are upgrading from the previous backend.

### DCP commands not available

If `/dcp-compress` doesn't work:

1. Verify DCP is installed: check `~/.config/opencode/node_modules/@tarquinen/opencode-dcp` exists.
2. Verify DCP is registered as an optional plugin in `config/ndomo.config.json`: `"optionalPlugins": ["@tarquinen/opencode-dcp"]`.
3. Restart OpenCode after installing.

DCP is optional — ndomo functions without it, but long sessions may exhaust context without pruning.

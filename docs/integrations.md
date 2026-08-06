# Integration Guide

## opencode-mem (required)

opencode-mem is a persistent memory system for OpenCode. It provides a local vector database (SQLite + USearch) with semantic search across sessions.

**License:** MIT

### What it is

opencode-mem stores and retrieves developer knowledge across sessions. ndomo uses it as the primary persistence layer — every agent stores and searches memories before planning or executing tasks.

### How ndomo uses it

The foreman searches memory before every planning cycle:

1. **Project search** — `memory({mode:"search", query, scope:"project"})` retrieves past decisions from the current project.
2. **Cross-project search** — `memory({mode:"search", query, scope:"all-projects"})` retrieves knowledge from all projects.
3. **Compressed storage** — before calling `memory({mode:"add"})`, ndomo compresses content using caveman regex patterns (0 LLM tokens).

### Tool usage

| Mode | Call | Purpose |
|---|---|---|
| search | `memory({mode:"search", query, scope:"project"})` | Search current project memories |
| search | `memory({mode:"search", query, scope:"all-projects"})` | Search all project memories |
| add | `memory({mode:"add", content, topic})` | Store a new memory entry |
| add | `memory({mode:"add", content, topic, tags})` | Store with tags for filtering |

### Web UI

opencode-mem includes a web UI at `http://localhost:4747` for browsing and managing memory entries.

### Config

See [configuration.md](configuration.md#memory-config) for memory-specific settings (`storagePath`, `defaultScope`, `autoCaptureEnabled`, `cavemanCompress`).

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

### opencode-mem not found

```
Error: Cannot find module 'opencode-mem'
```

Ensure opencode-mem is installed. ndomo lists it as a dependency in `package.json` — `bun install` should install it automatically. If not: `bun add opencode-mem`.

### Web UI not accessible

```
curl http://localhost:4747
Connection refused
```

Verify opencode-mem is running. Start it manually: `npx opencode-mem serve`. Default port is 4747.

### DCP commands not available

If `/dcp-compress` doesn't work:

1. Verify DCP is installed: check `~/.config/opencode/node_modules/@tarquinen/opencode-dcp` exists.
2. Verify DCP is registered as an optional plugin in `config/ndomo.config.json`: `"optionalPlugins": ["@tarquinen/opencode-dcp"]`.
3. Restart OpenCode after installing.

DCP is optional — ndomo functions without it, but long sessions may exhaust context without pruning.

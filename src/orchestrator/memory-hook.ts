/**
 * Pre-add caveman compression for memory entries.
 * Transforms verbose text into compressed caveman format before
 * storing in opencode-mem, saving tokens on retrieval.
 *
 * All compression is regex-based (0 LLM tokens).
 */

/** A memory entry ready for storage. */
export interface MemoryEntry {
  /** The content to store. */
  content: string;
  /** Topic/category for the memory. */
  topic: string;
  /** Whether this is project-scoped or global. */
  scope: "project" | "all-projects";
  /** Optional tags for filtering. */
  tags?: string[];
}

/**
 * Regex patterns for caveman compression.
 * Each pattern is applied sequentially to the text.
 */
const COMPRESSION_PATTERNS = [
  // Drop leading conjunctions: "And then...", "But actually...", "So basically..."
  { pattern: /^(?:and|but|or|so|then|also|well)\s+/gi, replacement: "" },

  // Drop filler adverbs anywhere in the sentence
  {
    pattern:
      /\b(?:just|really|basically|actually|simply|literally|honestly|seriously|obviously|definitely|probably|certainly|essentially|fundamentally|effectively)\b\s*/gi,
    replacement: "",
  },

  // Drop articles: English
  { pattern: /\b(?:the|a|an)\b\s*/gi, replacement: "" },

  // Drop articles: Spanish (for bilingual contexts)
  { pattern: /\b(?:el|la|los|las|un|una|unos|unas)\b\s*/gi, replacement: "" },

  // Drop filler phrases
  {
    pattern:
      /\b(?:in order to|due to the fact that|it is important to note that|it should be noted that|as a matter of fact|at the end of the day|for what it's worth|the thing is|what I mean is)\b\s*/gi,
    replacement: "",
  },

  // Collapse multiple spaces into one
  { pattern: / {2,}/g, replacement: " " },

  // Collapse multiple newlines into max two
  { pattern: /\n{3,}/g, replacement: "\n\n" },
] as const;

/**
 * URL pattern to protect URLs from compression.
 * Matches http://, https://, and common git/ssh URLs.
 */
const URL_PATTERN = /(?:https?:\/\/|git@|ssh:\/\/)[^\s`)\]]+/g;

/**
 * Code block pattern to protect code from compression.
 * Matches fenced code blocks: ```...```
 */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

/**
 * Compress text into caveman format using regex transformations.
 *
 * Preserves:
 * - Fenced code blocks (```...```)
 * - URLs (http://, https://, git@, ssh://)
 *
 * Removes:
 * - Articles (a, an, the, el, la, los, las, un, una)
 * - Filler words (just, really, basically, actually, simply, etc.)
 * - Leading conjunctions (and, but, or, so, then, also)
 * - Filler phrases ("in order to", "it is important to note that", etc.)
 * - Excess whitespace
 *
 * @param text - Input text to compress.
 * @returns Compressed caveman text.
 */
export function cavemanCompress(text: string): string {
  if (!text || text.trim().length === 0) return text;

  // Step 1: Extract protected regions (code blocks and URLs)
  const protectedRegions: Array<{ start: number; end: number; text: string }> = [];

  // Extract code blocks first
  for (const match of text.matchAll(CODE_BLOCK_PATTERN)) {
    if (match.index !== undefined) {
      protectedRegions.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      });
    }
  }

  // Extract URLs (skip those inside code blocks)
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index !== undefined) {
      const idx = match.index;
      const isInsideCodeBlock = protectedRegions.some((r) => idx >= r.start && idx < r.end);
      if (!isInsideCodeBlock) {
        protectedRegions.push({
          start: idx,
          end: idx + match[0].length,
          text: match[0],
        });
      }
    }
  }

  // Sort by start position (descending) for safe replacement
  protectedRegions.sort((a, b) => b.start - a.start);

  // Step 2: Replace protected regions with placeholders
  let workingText = text;
  const placeholders: string[] = [];

  for (const region of protectedRegions) {
    const placeholder = `\x00PROTECTED_${placeholders.length}\x00`;
    placeholders.push(region.text);
    workingText = workingText.slice(0, region.start) + placeholder + workingText.slice(region.end);
  }

  // Step 3: Apply compression patterns
  for (const { pattern, replacement } of COMPRESSION_PATTERNS) {
    workingText = workingText.replace(pattern, replacement);
  }

  // Step 4: Restore protected regions
  for (const [i, region] of placeholders.entries()) {
    workingText = workingText.replace(`\x00PROTECTED_${i}\x00`, region);
  }

  // Step 5: Final trim
  return workingText.trim();
}

/**
 * Prepare a memory entry for storage by compressing its content.
 * Returns a new MemoryEntry — does not mutate the original.
 *
 * @param entry - Raw memory entry.
 * @returns New MemoryEntry with compressed content.
 */
export function prepareForMemory(entry: MemoryEntry): MemoryEntry {
  return {
    ...entry,
    content: cavemanCompress(entry.content),
  };
}

/**
 * Determine whether content is worth storing in memory.
 *
 * Filters out:
 * - Trivial content (< 20 chars after compression)
 * - Pure code blocks with no prose to summarize
 *
 * @param content - Content to evaluate.
 * @returns `true` if the content should be stored.
 */
export function shouldStoreMemory(content: string): boolean {
  const compressed = cavemanCompress(content);

  // Too short after compression — not worth storing
  if (compressed.length < 20) return false;

  // Check if content is purely code blocks
  const withoutCodeBlocks = compressed.replace(CODE_BLOCK_PATTERN, "").trim();
  if (withoutCodeBlocks.length < 10) {
    // Almost all code, very little prose — not useful for memory search
    return false;
  }

  return true;
}

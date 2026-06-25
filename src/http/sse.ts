// ─── SSE Format Helpers ──────────────────────────────────────────────────────
/**
 * Pure functions for encoding Server-Sent Events (SSE) format.
 *
 * SSE spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
 * Format: `field: value\n` lines terminated by `\n` (blank line = end of event).
 *
 * All functions return strings — callers encode to Uint8Array themselves.
 */
import type { ReadableStreamDefaultController } from "node:stream/web";

/**
 * Encode a single event in SSE format.
 *
 * @param opts.eventName - optional event name (maps to `event:` field)
 * @param opts.data - JSON-serializable payload (multi-line data splits into multiple `data:` lines)
 * @param opts.id - optional event ID (for Last-Event-ID resume)
 * @returns SSE-formatted string ending with `\n\n`
 */
export function formatSseEvent(opts: { eventName?: string; data: unknown; id?: string }): string {
  const lines: string[] = [];
  if (opts.eventName) lines.push(`event: ${opts.eventName}`);
  if (opts.id) lines.push(`id: ${opts.id}`);
  // Multi-line data must split each line into a separate `data:` field
  const dataStr = JSON.stringify(opts.data);
  for (const line of dataStr.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/**
 * SSE keepalive comment — prevents proxy/load-balancer timeouts.
 * Format: `: keepalive\n\n` (colon = comment, ignored by clients).
 */
export function formatKeepalive(): string {
  return ": keepalive\n\n\n";
}

/**
 * Writer interface for SSE streams.
 *
 * Abstracts the ReadableStream controller + abort signal into a
 * clean API that handles encoding, error suppression, and cleanup.
 */
export interface SseWriter {
  /** Write a named event with JSON data. */
  write(eventName: string | null, data: unknown): void;
  /** Write a keepalive comment to prevent proxy timeouts. */
  writeKeepalive(): void;
  /** Close the stream. */
  end(): void;
  /** Register a cleanup callback invoked on abort. */
  onCleanup(cb: () => void): void;
}

/**
 * Wrap a Node ReadableStream controller + abort signal into a SseWriter.
 *
 * The writer suppresses all write errors (controller already closed)
 * and runs registered cleanup callbacks when the abort signal fires.
 *
 * @param controller - the ReadableStream controller to write to
 * @param signal - abort signal (from request.signal) for cleanup
 */
export function createSseWriter(
  controller: ReadableStreamDefaultController<Uint8Array>,
  signal: AbortSignal,
): SseWriter {
  const encoder = new TextEncoder();
  const cleanups: Array<() => void> = [];

  signal.addEventListener("abort", () => {
    for (const cb of cleanups) {
      try {
        cb();
      } catch {
        /* ignore cleanup errors */
      }
    }
    try {
      controller.close();
    } catch {
      /* already closed */
    }
  });

  return {
    write(eventName, data) {
      try {
        const chunk = formatSseEvent({
          ...(eventName !== null ? { eventName } : {}),
          data,
        });
        controller.enqueue(encoder.encode(chunk));
      } catch {
        // Controller closed — ignore
      }
    },
    writeKeepalive() {
      try {
        controller.enqueue(encoder.encode(formatKeepalive()));
      } catch {
        /* ignore */
      }
    },
    end() {
      try {
        controller.close();
      } catch {
        /* ignore */
      }
    },
    onCleanup(cb) {
      cleanups.push(cb);
    },
  };
}

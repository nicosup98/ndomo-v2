// ─── OpenCode Client Singleton ───────────────────────────────────────────────
/**
 * Singleton wrapper around `OpenCode.make` from `@opencode/client` (v2).
 *
 * Reads `OPENCODE_SERVER_URL` env (default `http://localhost:4096`).
 * Project scoping is passed as the `x-opencode-directory` header (the same
 * signal the v2 client uses internally for global-scoped requests).
 *
 * Recreates the client if baseUrl or directory change between calls.
 * Throws on construction if the server is unreachable (server.info health check).
 */
import { OpenCode, type OpenCodeClient } from "@opencode/client";

let cachedClient: OpenCodeClient | null = null;
let cachedConfig: { baseUrl: string; directory: string } | null = null;

export type { OpenCodeClient };

export interface SdkClientHandle {
  client: OpenCodeClient;
  baseUrl: string;
  directory: string;
}

/**
 * Get or create a singleton OpenCode client.
 *
 * @param opts.optional baseUrl override (default: OPENCODE_SERVER_URL or http://localhost:4096)
 * @param opts.optional directory override (default: process.cwd())
 * @returns SdkClientHandle with the connected client
 * @throws if the OpenCode server is unreachable (server.info fails)
 */
export async function getSdkClient(opts?: {
  baseUrl?: string;
  directory?: string;
}): Promise<SdkClientHandle> {
  const baseUrl = opts?.baseUrl ?? process.env.OPENCODE_SERVER_URL ?? "http://localhost:4096";
  const directory = opts?.directory ?? process.cwd();

  // Return cached client if config matches
  if (cachedClient && cachedConfig?.baseUrl === baseUrl && cachedConfig.directory === directory) {
    return { client: cachedClient, baseUrl, directory };
  }

  const client = OpenCode.make({
    baseUrl,
    headers: { "x-opencode-directory": encodeURIComponent(directory) },
  });

  // Health check — fetch server info to verify connectivity
  try {
    await client.server.info();
  } catch (err) {
    throw new Error(
      `OpenCode server unreachable at ${baseUrl} (directory=${directory}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  cachedClient = client;
  cachedConfig = { baseUrl, directory };
  return { client, baseUrl, directory };
}

/**
 * Reset the cached client. Useful for testing or when the server
 * connection needs to be re-established.
 */
export function resetSdkClient(): void {
  cachedClient = null;
  cachedConfig = null;
}

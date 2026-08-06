// ─── OpenCode SDK Client Singleton ───────────────────────────────────────────
/**
 * Singleton wrapper around `createOpencodeClient` from `@opencode-ai/sdk`.
 *
 * Reads `OPENCODE_SERVER_URL` env (default `http://localhost:4096`).
 * Uses `directory: process.cwd()` for project scoping via
 * `x-opencode-directory` header (handled internally by the SDK).
 *
 * Recreates the client if baseUrl or directory change between calls.
 * Throws on construction if the SDK server is unreachable (config.get health check).
 */
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";

let cachedClient: OpencodeClient | null = null;
let cachedConfig: { baseUrl: string; directory: string } | null = null;

export interface SdkClientHandle {
  client: OpencodeClient;
  baseUrl: string;
  directory: string;
}

/**
 * Get or create a singleton SDK client.
 *
 * @param opts.optional baseUrl override (default: OPENCODE_SERVER_URL or http://localhost:4096)
 * @param opts.optional directory override (default: process.cwd())
 * @returns SdkClientHandle with the connected client
 * @throws if the SDK server is unreachable (config.get fails)
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

  const client = createOpencodeClient({ baseUrl, directory });

  // Health check — fetch config to verify connectivity
  try {
    await client.config.get({ throwOnError: true });
  } catch (err) {
    throw new Error(
      `OpenCode SDK unreachable at ${baseUrl} (directory=${directory}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  cachedClient = client;
  cachedConfig = { baseUrl, directory };
  return { client, baseUrl, directory };
}

/**
 * Reset the cached SDK client. Useful for testing or when the server
 * connection needs to be re-established.
 */
export function resetSdkClient(): void {
  cachedClient = null;
  cachedConfig = null;
}

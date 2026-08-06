/**
 * ndomo web — API client with Basic Auth.
 *
 * Password stored in sessionStorage (tab-scoped, cleared on close).
 * 401 → throw HttpError (AuthPrompt component handles re-prompt).
 */

import type { ApiError } from "@/types/api";

const PASSWORD_KEY = "ndomo_auth_password";
const BASE_URL = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

// ─── Password management ────────────────────────────────────────────────────

export function getPassword(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(PASSWORD_KEY);
}

export function setPassword(pw: string): void {
  sessionStorage.setItem(PASSWORD_KEY, pw);
}

export function clearPassword(): void {
  sessionStorage.removeItem(PASSWORD_KEY);
}

export function authHeader(): string | null {
  const pw = getPassword();
  if (!pw) return null;
  const token = btoa(`anonymous:${pw}`);
  return `Basic ${token}`;
}

// ─── HttpError ──────────────────────────────────────────────────────────────

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
  ) {
    super(body.message ?? body.error ?? `HTTP ${status}`);
    this.name = "HttpError";
  }
}

// ─── Fetch wrapper ──────────────────────────────────────────────────────────

function buildUrl(path: string, params?: Record<string, string | number | boolean>): string {
  const url = new URL(BASE_URL + path, BASE_URL || window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    throw new HttpError(401, { error: "unauthorized", status: 401 });
  }
  if (!res.ok) {
    let body: ApiError;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      body = { error: "http_error", status: res.status };
    }
    throw new HttpError(res.status, body);
  }
  return (await res.json()) as T;
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | boolean>,
): Promise<T> {
  const url = buildUrl(path, params);
  const headers: Record<string, string> = { Accept: "application/json" };
  const auth = authHeader();
  if (auth) headers["Authorization"] = auth;

  const res = await fetch(url, { method: "GET", headers });
  return handleResponse<T>(res);
}

// ─── Write helpers ───────────────────────────────────────────────────────────

function jsonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const auth = authHeader();
  if (auth) headers["Authorization"] = auth;
  return headers;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const url = buildUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const url = buildUrl(path);
  const res = await fetch(url, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const url = buildUrl(path);
  const res = await fetch(url, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function apiDelete(path: string, body?: unknown): Promise<void> {
  const url = buildUrl(path);
  const headers = jsonHeaders();
  const init: RequestInit = { method: "DELETE", headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  // 204 No Content is success with no body
  if (res.status === 204) return;
  // Non-2xx → throw
  if (!res.ok) {
    let errBody: ApiError;
    try {
      errBody = (await res.json()) as ApiError;
    } catch {
      errBody = { error: "http_error", status: res.status };
    }
    throw new HttpError(res.status, errBody);
  }
}

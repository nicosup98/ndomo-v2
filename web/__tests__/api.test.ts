import { describe, it, expect, beforeEach, vi } from "vitest";
import { apiGet, HttpError, setPassword, clearPassword, authHeader, getPassword } from "../src/api/client";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("sessionStorage", {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  clearPassword();
});

describe("authHeader", () => {
  it("returns null when no password set", () => {
    vi.mocked(sessionStorage.getItem).mockReturnValue(null);
    expect(authHeader()).toBeNull();
  });

  it("returns Basic header when password set", () => {
    setPassword("secret123");
    // authHeader reads from sessionStorage
    vi.mocked(sessionStorage.getItem).mockReturnValue("secret123");
    const header = authHeader();
    expect(header).toBe("Basic " + btoa("anonymous:secret123"));
  });
});

describe("apiGet", () => {
  it("returns parsed JSON on 200", async () => {
    const payload = { status: "ok" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    });
    const result = await apiGet<{ status: string }>("/health");
    expect(result).toEqual(payload);
  });

  it("throws HttpError on 401", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "unauthorized" }),
    });
    try {
      await apiGet("/plans");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(401);
    }
  });

  it("throws HttpError on 500 with body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "internal", message: "db fail" }),
    });
    await expect(apiGet("/plans")).rejects.toMatchObject({
      status: 500,
      body: { error: "internal", message: "db fail" },
    });
  });

  it("throws HttpError on non-JSON error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error("not json")),
    });
    await expect(apiGet("/plans")).rejects.toMatchObject({
      status: 502,
      body: { error: "http_error", status: 502 },
    });
  });

  it("includes Authorization header when password set", async () => {
    setPassword("mypw");
    vi.mocked(sessionStorage.getItem).mockReturnValue("mypw");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    await apiGet("/plans");
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.headers).toMatchObject({
      Authorization: "Basic " + btoa("anonymous:mypw"),
    });
  });

  it("appends query params to URL", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    await apiGet("/plans", { status: "executing", limit: 5 });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("status=executing");
    expect(url).toContain("limit=5");
  });
});

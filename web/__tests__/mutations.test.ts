import { describe, it, expect, beforeEach, vi } from "vitest";
import { apiPost, apiPut, apiPatch, apiDelete, HttpError, setPassword, clearPassword } from "../src/api/client";
import { usePlanMutations } from "../src/composables/usePlanMutations";
import { useTaskMutations } from "../src/composables/useTaskMutations";

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

// ─── API client write helpers ────────────────────────────────────────────────

describe("apiPost", () => {
  it("returns parsed JSON on 201", async () => {
    const created = { id: "p1", slug: "test" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(created),
    });
    const result = await apiPost("/api/plans", { slug: "test", title: "T", overview: "O", createdBy: "user" });
    expect(result).toEqual(created);
  });

  it("sends JSON body with POST method", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    const body = { slug: "x", title: "X", overview: "O", createdBy: "u" };
    await apiPost("/api/plans", body);
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe(JSON.stringify(body));
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("throws HttpError on 422 validation error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ error: "validation", message: "slug required" }),
    });
    await expect(apiPost("/api/plans", {})).rejects.toMatchObject({
      status: 422,
      body: { error: "validation", message: "slug required" },
    });
  });
});

describe("apiPut", () => {
  it("returns parsed JSON on 200", async () => {
    const updated = { id: "p1", title: "new" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(updated),
    });
    const result = await apiPut("/api/plans/p1", { title: "new", updatedBy: "u" });
    expect(result).toEqual(updated);
  });

  it("throws HttpError on 404", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "not_found" }),
    });
    await expect(apiPut("/api/plans/missing", { updatedBy: "u" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("apiPatch", () => {
  it("returns parsed JSON on 200", async () => {
    const patched = { id: "p1", status: "approved" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(patched),
    });
    const result = await apiPatch("/api/plans/p1/status", { status: "approved", updatedBy: "u" });
    expect(result).toEqual(patched);
  });
});

describe("apiDelete", () => {
  it("returns void on 204", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });
    const result = await apiDelete("/api/plans/p1", { confirm: true, updatedBy: "u" });
    expect(result).toBeUndefined();
  });

  it("throws HttpError on 403", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: "forbidden" }),
    });
    await expect(apiDelete("/api/plans/p1")).rejects.toMatchObject({ status: 403 });
  });

  it("includes Authorization header when password set", async () => {
    setPassword("pw123");
    vi.mocked(sessionStorage.getItem).mockReturnValue("pw123");
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });
    await apiDelete("/api/plans/p1");
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>).Authorization).toBe("Basic " + btoa("anonymous:pw123"));
  });
});

// ─── usePlanMutations ────────────────────────────────────────────────────────

describe("usePlanMutations", () => {
  it("create sets isLoading false + error null on success", async () => {
    const created = { id: "p1", slug: "test" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(created),
    });
    const { create, isLoading, error } = usePlanMutations();
    const result = await create({ slug: "test", title: "T", overview: "O", createdBy: "u" });
    expect(result).toEqual(created);
    expect(isLoading.value).toBe(false);
    expect(error.value).toBeNull();
  });

  it("create sets error and re-throws on failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ error: "validation", message: "bad input" }),
    });
    const { create, isLoading, error } = usePlanMutations();
    await expect(create({ slug: "", title: "", overview: "", createdBy: "" })).rejects.toBeInstanceOf(HttpError);
    expect(isLoading.value).toBe(false);
    expect(error.value).toBe("bad input");
  });

  it("approve wraps POST /api/plans/:id/approve", async () => {
    const approved = { id: "p1", status: "approved" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(approved),
    });
    const { approve } = usePlanMutations();
    const result = await approve("p1", "admin");
    expect(result).toEqual(approved);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/plans/p1/approve");
    expect(opts.method).toBe("POST");
  });
});

// ─── useTaskMutations ────────────────────────────────────────────────────────

describe("useTaskMutations", () => {
  it("create sets isLoading false + error null on success", async () => {
    const created = { id: "t1", description: "do stuff" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(created),
    });
    const { create, isLoading, error } = useTaskMutations();
    const result = await create("p1", { description: "do stuff", agent: "craftsman" });
    expect(result).toEqual(created);
    expect(isLoading.value).toBe(false);
    expect(error.value).toBeNull();
  });

  it("patchStatus sets error and re-throws on failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "bad_status", message: "invalid transition" }),
    });
    const { patchStatus, error } = useTaskMutations();
    await expect(patchStatus("t1", { status: "done", updatedBy: "u" })).rejects.toBeInstanceOf(HttpError);
    expect(error.value).toBe("invalid transition");
  });

  it("reassign wraps PATCH /api/tasks/:id/reassign", async () => {
    const reassigned = { id: "t1", agent: "new-agent" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(reassigned),
    });
    const { reassign } = useTaskMutations();
    const result = await reassign("t1", { agent: "new-agent", updatedBy: "admin" });
    expect(result).toEqual(reassigned);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/tasks/t1/reassign");
    expect(opts.method).toBe("PATCH");
  });
});

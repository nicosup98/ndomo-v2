import { describe, it, expect, vi } from "vitest";
import { useApi } from "../src/composables/useApi";
import { HttpError } from "../src/api/client";

describe("useApi", () => {
  it("sets loading true during fetch, false after", async () => {
    let resolve!: (v: string) => void;
    const p = new Promise<string>((r) => (resolve = r));
    const { loading, data } = useApi(() => p);

    expect(loading.value).toBe(true);
    expect(data.value).toBeNull();

    resolve("done");
    await vi.waitFor(() => expect(loading.value).toBe(false));
    expect(data.value).toBe("done");
  });

  it("sets data on success", async () => {
    const { data, error } = useApi(() => Promise.resolve({ id: "1" }));
    await vi.waitFor(() => expect(data.value).toEqual({ id: "1" }));
    expect(error.value).toBeNull();
  });

  it("sets error on HttpError", async () => {
    const err = new HttpError(401, { error: "unauthorized" });
    const { data, error } = useApi(() => Promise.reject(err));
    await vi.waitFor(() => expect(error.value).toBe(err));
    expect(data.value).toBeNull();
  });

  it("wraps unknown errors in HttpError", async () => {
    const { error } = useApi(() => Promise.reject(new Error("boom")));
    await vi.waitFor(() => expect(error.value).toBeInstanceOf(HttpError));
    expect(error.value!.body.error).toBe("unknown");
  });

  it("refresh re-fetches and clears error", async () => {
    let callCount = 0;
    const { data, error, refresh } = useApi(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new HttpError(500, { error: "fail" }));
      return Promise.resolve("ok");
    });

    await vi.waitFor(() => expect(error.value).toBeInstanceOf(HttpError));
    expect(data.value).toBeNull();

    await refresh();
    expect(data.value).toBe("ok");
    expect(error.value).toBeNull();
  });
});

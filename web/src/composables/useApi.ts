/**
 * ndomo web — Reactive API wrapper composable.
 *
 * Wraps any async fetcher into reactive { data, error, loading, refresh }.
 * Auto-fetches on mount. Returns refs for template binding.
 */

import { ref, type Ref } from "vue";
import { HttpError } from "@/api/client";

export interface UseApiResult<T> {
  data: Ref<T | null>;
  error: Ref<HttpError | null>;
  loading: Ref<boolean>;
  refresh: () => Promise<void>;
}

export function useApi<T>(fetcher: () => Promise<T>): UseApiResult<T> {
  const data = ref<T | null>(null) as Ref<T | null>;
  const error = ref<HttpError | null>(null);
  const loading = ref(false);

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      data.value = await fetcher();
    } catch (e: unknown) {
      if (e instanceof HttpError) {
        error.value = e;
      } else {
        error.value = new HttpError(0, {
          error: "unknown",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      loading.value = false;
    }
  }

  void refresh();

  return { data, error, loading, refresh };
}

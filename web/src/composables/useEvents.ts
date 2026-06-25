/**
 * ndomo web — SSE events composable (stubbed for MVP).
 *
 * EventSource doesn't support custom Authorization headers in browsers.
 * ndomo uses Basic Auth (not cookies), so SSE returns 401 in browser.
 * MVP uses polling via useApi refresh instead.
 *
 * TODO: implement fetch+ReadableStream polyfill for real SSE in follow-up.
 */

import { ref } from "vue";

export interface NdomoEvent {
  type: string;
  data: unknown;
  timestamp: number;
}

export function useEvents() {
  const events = ref<NdomoEvent[]>([]);
  const connected = ref(false);

  // Stubbed — real SSE wiring deferred.
  return { events, connected };
}

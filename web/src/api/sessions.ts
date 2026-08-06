/**
 * ndomo web — Sessions API endpoints.
 */

import { apiGet } from "./client";
import type { Session } from "@/types/api";

export interface SessionFilters {
  planId?: string;
  limit?: number;
}

export function listSessions(filters?: SessionFilters): Promise<Session[]> {
  return apiGet<Session[]>("/api/sessions", filters as Record<string, string | number | boolean> | undefined);
}

export function getSession(id: string): Promise<Session> {
  return apiGet<Session>(`/api/sessions/${encodeURIComponent(id)}`);
}

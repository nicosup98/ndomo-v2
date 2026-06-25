/**
 * ndomo web — Plans API endpoints.
 */

import { apiGet } from "./client";
import type { Plan, PlanStatus } from "@/types/api";

export interface PlanFilters {
  status?: PlanStatus;
  sessionId?: string;
  limit?: number;
}

export function listPlans(filters?: PlanFilters): Promise<Plan[]> {
  return apiGet<Plan[]>("/api/plans", filters as Record<string, string | number | boolean> | undefined);
}

export function getPlan(id: string): Promise<Plan> {
  return apiGet<Plan>(`/api/plans/${encodeURIComponent(id)}`);
}

export function searchPlans(q: string, limit?: number): Promise<Plan[]> {
  return apiGet<Plan[]>("/api/plans/search", { q, ...(limit != null ? { limit } : {}) });
}

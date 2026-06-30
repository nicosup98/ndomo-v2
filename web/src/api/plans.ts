/**
 * ndomo web — Plans API endpoints.
 */

import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from "./client";
import type {
  Plan,
  PlanStatus,
  PlanCreateBody,
  PlanUpdateBody,
  PlanStatusPatch,
  PlanDeleteBody,
} from "@/types/api";

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

// ─── Write endpoints ─────────────────────────────────────────────────────────

export function createPlan(body: PlanCreateBody): Promise<Plan> {
  return apiPost<Plan>("/api/plans", body);
}

export function updatePlan(id: string, body: PlanUpdateBody): Promise<Plan> {
  return apiPut<Plan>(`/api/plans/${encodeURIComponent(id)}`, body);
}

export function patchPlanStatus(id: string, body: PlanStatusPatch): Promise<Plan> {
  return apiPatch<Plan>(`/api/plans/${encodeURIComponent(id)}/status`, body);
}

export function approvePlan(id: string, updatedBy: string): Promise<Plan> {
  return apiPost<Plan>(`/api/plans/${encodeURIComponent(id)}/approve`, { updatedBy });
}

export function deletePlan(id: string, updatedBy: string): Promise<void> {
  const body: PlanDeleteBody = { confirm: true, updatedBy };
  return apiDelete(`/api/plans/${encodeURIComponent(id)}`, body);
}

/**
 * ndomo web — Tasks API endpoints.
 */

import { apiGet } from "./client";
import type { Task, TaskStatus } from "@/types/api";

export interface TaskFilters {
  status?: TaskStatus;
}

export function listTasks(planId: string, filters?: TaskFilters): Promise<Task[]> {
  return apiGet<Task[]>("/api/tasks", {
    planId,
    ...(filters as Record<string, string | number | boolean> | undefined),
  });
}

export function getTask(id: string): Promise<Task> {
  return apiGet<Task>(`/api/tasks/${encodeURIComponent(id)}`);
}

export function searchTasks(q: string, limit?: number): Promise<Task[]> {
  return apiGet<Task[]>("/api/tasks/search", { q, ...(limit != null ? { limit } : {}) });
}

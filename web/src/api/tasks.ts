/**
 * ndomo web — Tasks API endpoints.
 */

import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from "./client";
import type {
  Task,
  TaskStatus,
  TaskCreateBody,
  TaskUpdateBody,
  TaskStatusPatch,
  TaskReassignBody,
  TaskDeleteBody,
} from "@/types/api";

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

// ─── Write endpoints ─────────────────────────────────────────────────────────

export function createTask(planId: string, body: TaskCreateBody): Promise<Task> {
  return apiPost<Task>(`/api/plans/${encodeURIComponent(planId)}/tasks`, body);
}

export function updateTask(id: string, body: TaskUpdateBody): Promise<Task> {
  return apiPut<Task>(`/api/tasks/${encodeURIComponent(id)}`, body);
}

export function patchTaskStatus(id: string, body: TaskStatusPatch): Promise<Task> {
  return apiPatch<Task>(`/api/tasks/${encodeURIComponent(id)}/status`, body);
}

export function reassignTask(id: string, body: TaskReassignBody): Promise<Task> {
  return apiPatch<Task>(`/api/tasks/${encodeURIComponent(id)}/reassign`, body);
}

export function deleteTask(id: string, updatedBy: string): Promise<void> {
  const body: TaskDeleteBody = { confirm: true, updatedBy };
  return apiDelete(`/api/tasks/${encodeURIComponent(id)}`, body);
}

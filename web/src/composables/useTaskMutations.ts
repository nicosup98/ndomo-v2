/**
 * ndomo web — Task mutation composable.
 *
 * Wraps task write API calls with isLoading/error reactive state.
 * Components call methods directly; errors bubble up for UI handling.
 *
 * SSE events (task.created, task.updated, etc.) trigger list refreshes
 * via useSseRefresh — no manual cache invalidation needed here.
 */

import { ref, type Ref } from "vue";
import {
  createTask,
  updateTask,
  patchTaskStatus,
  reassignTask,
  deleteTask,
} from "@/api/tasks";
import { HttpError } from "@/api/client";
import type {
  Task,
  TaskCreateBody,
  TaskUpdateBody,
  TaskStatusPatch,
  TaskReassignBody,
} from "@/types/api";

export interface UseTaskMutationsResult {
  create: (planId: string, body: TaskCreateBody) => Promise<Task>;
  update: (id: string, body: TaskUpdateBody) => Promise<Task>;
  patchStatus: (id: string, body: TaskStatusPatch) => Promise<Task>;
  reassign: (id: string, body: TaskReassignBody) => Promise<Task>;
  remove: (id: string, updatedBy: string) => Promise<void>;
  isLoading: Ref<boolean>;
  error: Ref<string | null>;
}

function toErrorMessage(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function useTaskMutations(): UseTaskMutationsResult {
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  async function wrap<T>(fn: () => Promise<T>): Promise<T> {
    isLoading.value = true;
    error.value = null;
    try {
      return await fn();
    } catch (e: unknown) {
      error.value = toErrorMessage(e);
      throw e;
    } finally {
      isLoading.value = false;
    }
  }

  return {
    create: (planId, body) => wrap(() => createTask(planId, body)),
    update: (id, body) => wrap(() => updateTask(id, body)),
    patchStatus: (id, body) => wrap(() => patchTaskStatus(id, body)),
    reassign: (id, body) => wrap(() => reassignTask(id, body)),
    remove: (id, updatedBy) => wrap(() => deleteTask(id, updatedBy)),
    isLoading,
    error,
  };
}

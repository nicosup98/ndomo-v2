/**
 * ndomo web — Plan mutation composable.
 *
 * Wraps plan write API calls with isLoading/error reactive state.
 * Components call methods directly; errors bubble up for UI handling.
 *
 * SSE events (plan.created, plan.updated, etc.) trigger list refreshes
 * via useSseRefresh — no manual cache invalidation needed here.
 */

import { ref, type Ref } from "vue";
import {
  createPlan,
  updatePlan,
  patchPlanStatus,
  approvePlan,
  deletePlan,
} from "@/api/plans";
import { HttpError } from "@/api/client";
import type {
  Plan,
  PlanCreateBody,
  PlanUpdateBody,
  PlanStatusPatch,
} from "@/types/api";

export interface UsePlanMutationsResult {
  create: (body: PlanCreateBody) => Promise<Plan>;
  update: (id: string, body: PlanUpdateBody) => Promise<Plan>;
  patchStatus: (id: string, body: PlanStatusPatch) => Promise<Plan>;
  approve: (id: string, updatedBy: string) => Promise<Plan>;
  remove: (id: string, updatedBy: string) => Promise<void>;
  isLoading: Ref<boolean>;
  error: Ref<string | null>;
}

function toErrorMessage(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function usePlanMutations(): UsePlanMutationsResult {
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
    create: (body) => wrap(() => createPlan(body)),
    update: (id, body) => wrap(() => updatePlan(id, body)),
    patchStatus: (id, body) => wrap(() => patchPlanStatus(id, body)),
    approve: (id, updatedBy) => wrap(() => approvePlan(id, updatedBy)),
    remove: (id, updatedBy) => wrap(() => deletePlan(id, updatedBy)),
    isLoading,
    error,
  };
}

<script setup lang="ts">
/**
 * StatusActions — context-aware action buttons for plans and tasks.
 *
 * Renders only valid actions for the current status.
 * Props: kind ('plan'|'task'), plan OR task (discriminated union).
 * Emits: changed after successful mutation (parent should refetch).
 */
import { computed } from "vue";
import { usePlanMutations } from "@/composables/usePlanMutations";
import { useTaskMutations } from "@/composables/useTaskMutations";
import type { Plan, Task } from "@/types/api";

const props = defineProps<{
  kind: "plan" | "task";
  plan?: Plan;
  task?: Task;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const planMutations = usePlanMutations();
const taskMutations = useTaskMutations();

const isLoading = computed(() =>
  props.kind === "plan" ? planMutations.isLoading.value : taskMutations.isLoading.value,
);

const errorMsg = computed(() =>
  props.kind === "plan" ? planMutations.error.value : taskMutations.error.value,
);

// ─── Plan actions ───────────────────────────────────────────────────────────

const planActions = computed(() => {
  if (props.kind !== "plan" || !props.plan) return [];
  const s = props.plan.status;
  const actions: Array<{ label: string; cls: string; handler: () => Promise<void> }> = [];

  if (s === "draft") {
    actions.push({
      label: "Approve",
      cls: "btn btn-primary btn-sm",
      handler: async () => {
        await planMutations.approve(props.plan!.id, "craftsman");
        emit("changed");
      },
    });
  }

  if (s === "approved" || s === "executing") {
    actions.push({
      label: "Mark Complete",
      cls: "btn btn-success btn-sm",
      handler: async () => {
        await planMutations.patchStatus(props.plan!.id, {
          status: "completed",
          updatedBy: "craftsman",
          result: "ok",
        });
        emit("changed");
      },
    });
    actions.push({
      label: "Fail",
      cls: "btn btn-error btn-sm",
      handler: async () => {
        await planMutations.patchStatus(props.plan!.id, {
          status: "failed",
          updatedBy: "craftsman",
          error: "manual",
        });
        emit("changed");
      },
    });
  }

  if (s === "completed" || s === "failed") {
    actions.push({
      label: "Archive",
      cls: "btn btn-ghost btn-sm",
      handler: async () => {
        await planMutations.remove(props.plan!.id, "craftsman");
        emit("changed");
      },
    });
  }

  return actions;
});

// ─── Task actions ───────────────────────────────────────────────────────────

const taskActions = computed(() => {
  if (props.kind !== "task" || !props.task) return [];
  const s = props.task.status;
  const actions: Array<{ label: string; cls: string; handler: () => Promise<void> }> = [];

  if (s === "pending" || s === "running") {
    actions.push({
      label: "Mark Done",
      cls: "btn btn-success btn-sm",
      handler: async () => {
        await taskMutations.patchStatus(props.task!.id, {
          status: "done",
          updatedBy: "craftsman",
          result: "ok",
        });
        emit("changed");
      },
    });
    actions.push({
      label: "Mark Failed",
      cls: "btn btn-error btn-sm",
      handler: async () => {
        await taskMutations.patchStatus(props.task!.id, {
          status: "failed",
          updatedBy: "craftsman",
          error: "manual",
        });
        emit("changed");
      },
    });
  }

  if (s === "done" || s === "failed") {
    actions.push({
      label: "Delete",
      cls: "btn btn-ghost btn-sm text-error",
      handler: async () => {
        await taskMutations.remove(props.task!.id, "craftsman");
        emit("changed");
      },
    });
  }

  return actions;
});

const actions = computed(() =>
  props.kind === "plan" ? planActions.value : taskActions.value,
);
</script>

<template>
  <div>
    <!-- Error -->
    <div v-if="errorMsg" role="alert" class="alert alert-error mb-2">
      <span>{{ errorMsg }}</span>
    </div>

    <!-- Action buttons -->
    <div v-if="actions.length > 0" class="flex gap-2 flex-wrap">
      <button
        v-for="(action, i) in actions"
        :key="i"
        :class="action.cls"
        :disabled="isLoading"
        @click="action.handler"
      >
        <span v-if="isLoading" class="loading loading-spinner loading-xs" />
        {{ action.label }}
      </button>
    </div>
    <p v-else class="text-sm opacity-50">No actions available for current status.</p>
  </div>
</template>

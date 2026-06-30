<script setup lang="ts">
import type { PlanStatus, TaskStatus } from "@/types/api";

const props = defineProps<{
  status: PlanStatus | TaskStatus;
}>();

const bulmaMap: Record<string, string> = {
  pending: "is-light",
  running: "is-info",
  done: "is-success",
  failed: "is-danger",
  blocked: "is-warning",
  draft: "is-light",
  approved: "is-primary",
  executing: "is-info",
  completed: "is-success",
  abandoned: "is-dark",
};

const bulmaClass = bulmaMap[props.status] ?? "is-light";
</script>

<template>
  <span
    class="tag"
    :class="bulmaClass"
    :aria-label="`status: ${props.status}`"
  >
    {{ props.status }}
  </span>
</template>

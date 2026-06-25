<script setup lang="ts">
import type { PlanStatus, TaskStatus } from "@/types/api";

const props = defineProps<{
  status: PlanStatus | TaskStatus;
}>();

const labelMap: Record<string, string> = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
  blocked: "blocked",
  draft: "draft",
  approved: "approved",
  executing: "executing",
  completed: "completed",
  abandoned: "abandoned",
};

const cssVarMap: Record<string, string> = {
  pending: "--status-pending",
  running: "--status-running",
  done: "--status-done",
  failed: "--status-failed",
  blocked: "--status-blocked",
  draft: "--status-draft",
  approved: "--status-approved",
  executing: "--status-executing",
  completed: "--status-completed",
  abandoned: "--status-abandoned",
};
</script>

<template>
  <span
    class="status-badge"
    :style="{ color: `var(${cssVarMap[props.status] ?? '--text-muted'})` }"
    :aria-label="`status: ${labelMap[props.status] ?? props.status}`"
  >
    {{ labelMap[props.status] ?? props.status }}
  </span>
</template>

<style scoped>
.status-badge {
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  background: var(--bg-overlay);
  white-space: nowrap;
}
</style>

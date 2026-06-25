<script setup lang="ts">
import type { Task } from "@/types/api";
import StatusBadge from "./StatusBadge.vue";

defineProps<{
  task: Task;
}>();

defineEmits<{
  click: [id: string];
}>();

function formatDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
</script>

<template>
  <tr
    class="task-row"
    tabindex="0"
    role="link"
    :aria-label="`task: ${task.description}, agent: ${task.agent}, status: ${task.status}`"
    @click="$emit('click', task.id)"
    @keydown.enter="$emit('click', task.id)"
  >
    <td class="cell-status">
      <StatusBadge :status="task.status" />
    </td>
    <td class="cell-agent mono">{{ task.agent }}</td>
    <td class="cell-desc">{{ task.description }}</td>
    <td class="cell-duration mono muted">{{ formatDuration(task.durationMs) }}</td>
  </tr>
</template>

<style scoped>
.task-row {
  cursor: pointer;
  transition: background var(--t-fast);
}
.task-row:hover,
.task-row:focus-visible {
  background: var(--bg-elevated);
}
.task-row:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}
td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--fs-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell-agent {
  width: 120px;
}
.cell-desc {
  max-width: 500px;
  white-space: normal;
}
.cell-duration {
  text-align: right;
  width: 80px;
}
</style>

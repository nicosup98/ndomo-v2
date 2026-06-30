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
    class="is-clickable"
    tabindex="0"
    role="link"
    :aria-label="`task: ${task.description}, agent: ${task.agent}, status: ${task.status}`"
    @click="$emit('click', task.id)"
    @keydown.enter="$emit('click', task.id)"
  >
    <td><StatusBadge :status="task.status" /></td>
    <td class="is-family-monospace">{{ task.agent }}</td>
    <td>{{ task.description }}</td>
    <td class="has-text-right is-family-monospace has-text-grey">{{ formatDuration(task.durationMs) }}</td>
  </tr>
</template>

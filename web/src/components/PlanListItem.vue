<script setup lang="ts">
import type { Plan } from "@/types/api";
import StatusBadge from "./StatusBadge.vue";
import { useTimeAgo } from "@vueuse/core";

const props = defineProps<{
  plan: Plan;
}>();

const emit = defineEmits<{
  click: [id: string];
}>();

const timeAgo = useTimeAgo(() => props.plan.updatedAt);
</script>

<template>
  <tr
    class="plan-row"
    tabindex="0"
    role="link"
    :aria-label="`plan: ${plan.title}, status: ${plan.status}`"
    @click="emit('click', plan.id)"
    @keydown.enter="emit('click', plan.id)"
  >
    <td class="cell-title">
      <span class="plan-slug">{{ plan.slug }}</span>
    </td>
    <td class="cell-status">
      <StatusBadge :status="plan.status" />
    </td>
    <td class="cell-priority mono">{{ plan.priority }}</td>
    <td class="cell-complexity mono">{{ plan.complexity }}</td>
    <td class="cell-updated muted">{{ timeAgo }}</td>
  </tr>
</template>

<style scoped>
.plan-row {
  cursor: pointer;
  transition: background var(--t-fast);
}
.plan-row:hover,
.plan-row:focus-visible {
  background: var(--bg-elevated);
}
.plan-row:focus-visible {
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
  max-width: 300px;
}
.cell-title {
  max-width: 400px;
}
.plan-slug {
  color: var(--text-primary);
  font-weight: var(--fw-medium);
}
.cell-priority,
.cell-complexity {
  text-align: center;
  width: 60px;
}
.cell-updated {
  text-align: right;
  width: 120px;
}
</style>

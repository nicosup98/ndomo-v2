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
    class="is-clickable"
    tabindex="0"
    role="link"
    :aria-label="`plan: ${plan.title}, status: ${plan.status}`"
    @click="emit('click', plan.id)"
    @keydown.enter="emit('click', plan.id)"
  >
    <td>
      <span class="has-text-weight-semibold">{{ plan.slug }}</span>
    </td>
    <td>
      <StatusBadge :status="plan.status" />
    </td>
    <td class="has-text-centered">{{ plan.priority }}</td>
    <td class="has-text-centered">{{ plan.complexity }}</td>
    <td class="has-text-right has-text-grey">{{ timeAgo }}</td>
  </tr>
</template>

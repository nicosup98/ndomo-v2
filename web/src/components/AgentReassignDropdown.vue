<script setup lang="ts">
/**
 * AgentReassignDropdown — daisyUI dropdown to reassign a task's agent.
 *
 * Props: taskId, currentAgent
 * Emits: reassigned (task) after successful mutation.
 */
import { ref } from "vue";
import { useTaskMutations } from "@/composables/useTaskMutations";
import type { Task } from "@/types/api";

const AGENTS = [
  "craftsman",
  "js-smith",
  "vue-smith",
  "go-smith",
  "python-smith",
  "smith",
  "rust-smith",
  "ranger",
  "scout",
  "scribe",
  "inspector",
  "chronicler",
  "painter",
] as const;

const props = defineProps<{
  taskId: string;
  currentAgent: string;
}>();

const emit = defineEmits<{
  reassigned: [task: Task];
}>();

const mutations = useTaskMutations();
const isOpen = ref(false);

async function handleSelect(agent: string): Promise<void> {
  if (agent === props.currentAgent) {
    isOpen.value = false;
    return;
  }
  try {
    const task = await mutations.reassign(props.taskId, {
      agent,
      updatedBy: "craftsman",
    });
    emit("reassigned", task);
    isOpen.value = false;
  } catch {
    // error in mutations.error — shown inline
  }
}
</script>

<template>
  <details class="dropdown" :open="isOpen" @toggle="isOpen = ($event.target as HTMLDetailsElement).open">
    <summary class="btn btn-outline btn-sm">
      Reassign: {{ currentAgent }}
    </summary>
    <ul class="dropdown-content menu bg-base-100 rounded-box z-10 w-52 p-2 shadow-sm">
      <li v-if="mutations.error.value" class="text-error text-xs px-2 py-1">
        {{ mutations.error.value }}
      </li>
      <li v-if="mutations.isLoading.value" class="px-2 py-1">
        <span class="loading loading-spinner loading-xs" />
      </li>
      <li
        v-for="agent in AGENTS"
        :key="agent"
      >
        <a
          :class="{ 'font-bold bg-base-200': agent === currentAgent }"
          @click="handleSelect(agent)"
        >
          {{ agent }}
          <span v-if="agent === currentAgent" class="badge badge-sm">current</span>
        </a>
      </li>
    </ul>
  </details>
</template>

<script setup lang="ts">
/**
 * CreateTaskForm — add a task to an existing plan.
 *
 * Props: planId
 * Emits: created (task), cancel
 */
import { ref, computed } from "vue";
import { useTaskMutations } from "@/composables/useTaskMutations";
import type { Task, TaskCreateBody } from "@/types/api";

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
  planId: string;
}>();

const emit = defineEmits<{
  created: [task: Task];
  cancel: [];
}>();

const mutations = useTaskMutations();

// ─── Form state ─────────────────────────────────────────────────────────────

const description = ref("");
const agent = ref<string>("craftsman");
const filesRaw = ref("");
const complexity = ref(2);

const descriptionError = computed(() => {
  if (!description.value.trim()) return "Description is required";
  return null;
});

const isValid = computed(() => !descriptionError.value);

// ─── Submit ─────────────────────────────────────────────────────────────────

async function handleSubmit(): Promise<void> {
  if (!isValid.value) return;

  const body: TaskCreateBody = {
    description: description.value.trim(),
    agent: agent.value,
    complexity: complexity.value,
  };

  const files = filesRaw.value
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (files.length > 0) {
    body.files = files;
  }

  try {
    const task = await mutations.create(props.planId, body);
    emit("created", task);
    // Reset form after success
    description.value = "";
    filesRaw.value = "";
  } catch {
    // error displayed via mutations.error
  }
}
</script>

<template>
  <form @submit.prevent="handleSubmit" class="flex flex-col gap-4">
    <!-- Error alert -->
    <div v-if="mutations.error.value" role="alert" class="alert alert-error">
      <span>{{ mutations.error.value }}</span>
    </div>

    <!-- Description -->
    <fieldset class="fieldset">
      <legend class="fieldset-legend">Description *</legend>
      <textarea
        v-model="description"
        placeholder="What should be done?"
        class="textarea textarea-bordered w-full"
        :class="{ 'textarea-error': descriptionError }"
        rows="2"
        required
      />
      <p v-if="descriptionError" class="label text-error">{{ descriptionError }}</p>
    </fieldset>

    <!-- Agent + Complexity row -->
    <div class="grid grid-cols-2 gap-4">
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Agent</legend>
        <select v-model="agent" class="select select-bordered w-full">
          <option v-for="a in AGENTS" :key="a" :value="a">{{ a }}</option>
        </select>
      </fieldset>

      <fieldset class="fieldset">
        <legend class="fieldset-legend">Complexity</legend>
        <select v-model.number="complexity" class="select select-bordered w-full">
          <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
        </select>
      </fieldset>
    </div>

    <!-- Files -->
    <fieldset class="fieldset">
      <legend class="fieldset-legend">Files</legend>
      <input
        v-model="filesRaw"
        type="text"
        placeholder="src/foo.ts, src/bar.ts (comma-separated)"
        class="input input-bordered w-full"
      />
    </fieldset>

    <!-- Actions -->
    <div class="flex gap-2 justify-end mt-2">
      <button type="button" class="btn btn-ghost btn-sm" @click="emit('cancel')">
        Cancel
      </button>
      <button
        type="submit"
        class="btn btn-primary btn-sm"
        :disabled="!isValid || mutations.isLoading.value"
      >
        <span v-if="mutations.isLoading.value" class="loading loading-spinner loading-xs" />
        Add Task
      </button>
    </div>
  </form>
</template>

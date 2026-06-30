<script setup lang="ts">
/**
 * EditPlanForm — inline edit of plan mutable fields.
 *
 * Props: plan (full Plan object)
 * Emits: updated (plan after save), cancel
 *
 * Read-only fields: slug, status, owner, createdBy, createdAt.
 */
import { ref, computed } from "vue";
import { usePlanMutations } from "@/composables/usePlanMutations";
import type { Plan, PlanUpdateBody, PlanCategory, PlanOwner } from "@/types/api";

const props = defineProps<{
  plan: Plan;
}>();

const emit = defineEmits<{
  updated: [plan: Plan];
  cancel: [];
}>();

const mutations = usePlanMutations();

// ─── Form state (pre-populated from plan) ───────────────────────────────────

const title = ref(props.plan.title);
const overview = ref(props.plan.overview);
const approach = ref(props.plan.approach ?? "");
const priority = ref(props.plan.priority);
const complexity = ref(props.plan.complexity);
const category = ref<PlanCategory>(props.plan.category ?? "feature");
const owner = ref<PlanOwner>(
  (["foreman", "craftsman", "warden"].includes(props.plan.createdBy)
    ? props.plan.createdBy
    : "craftsman") as PlanOwner,
);

const titleError = computed(() => {
  if (!title.value.trim()) return "Title is required";
  return null;
});

const overviewError = computed(() => {
  if (!overview.value.trim()) return "Overview is required";
  if (overview.value.trim().length < 10) return "Overview must be at least 10 characters";
  return null;
});

const isValid = computed(() => !titleError.value && !overviewError.value);

// ─── Submit ─────────────────────────────────────────────────────────────────

async function handleSubmit(): Promise<void> {
  if (!isValid.value) return;

  const body: PlanUpdateBody = {
    title: title.value.trim(),
    overview: overview.value.trim(),
    priority: priority.value,
    complexity: complexity.value,
    category: category.value,
    owner: owner.value,
    updatedBy: owner.value,
  };
  if (approach.value.trim()) {
    body.approach = approach.value.trim();
  }

  try {
    const plan = await mutations.update(props.plan.id, body);
    emit("updated", plan);
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

    <!-- Read-only info -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm opacity-70">
      <div><span class="font-semibold">slug:</span> {{ plan.slug }}</div>
      <div><span class="font-semibold">status:</span> {{ plan.status }}</div>
      <div><span class="font-semibold">created by:</span> {{ plan.createdBy }}</div>
      <div><span class="font-semibold">owner:</span> {{ plan.createdBy }}</div>
    </div>

    <div class="divider" />

    <!-- Title -->
    <fieldset class="fieldset">
      <legend class="fieldset-legend">Title *</legend>
      <input
        v-model="title"
        type="text"
        class="input input-bordered w-full"
        :class="{ 'input-error': titleError }"
        required
      />
      <p v-if="titleError" class="label text-error">{{ titleError }}</p>
    </fieldset>

    <!-- Overview -->
    <fieldset class="fieldset">
      <legend class="fieldset-legend">Overview *</legend>
      <textarea
        v-model="overview"
        class="textarea textarea-bordered w-full"
        :class="{ 'textarea-error': overviewError }"
        rows="3"
        required
      />
      <p v-if="overviewError" class="label text-error">{{ overviewError }}</p>
    </fieldset>

    <!-- Approach -->
    <fieldset class="fieldset">
      <legend class="fieldset-legend">Approach</legend>
      <textarea
        v-model="approach"
        class="textarea textarea-bordered w-full"
        rows="3"
      />
    </fieldset>

    <!-- Priority + Complexity + Category -->
    <div class="grid grid-cols-3 gap-4">
      <fieldset class="fieldset">
        <legend class="fieldset-legend">Priority</legend>
        <select v-model.number="priority" class="select select-bordered w-full">
          <option v-for="n in 11" :key="n - 1" :value="n - 1">{{ n - 1 }}</option>
        </select>
      </fieldset>

      <fieldset class="fieldset">
        <legend class="fieldset-legend">Complexity</legend>
        <select v-model.number="complexity" class="select select-bordered w-full">
          <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
        </select>
      </fieldset>

      <fieldset class="fieldset">
        <legend class="fieldset-legend">Category</legend>
        <select v-model="category" class="select select-bordered w-full">
          <option value="feature">feature</option>
          <option value="refactor">refactor</option>
          <option value="bugfix">bugfix</option>
          <option value="docs">docs</option>
          <option value="infra">infra</option>
        </select>
      </fieldset>
    </div>

    <!-- Actions -->
    <div class="flex gap-2 justify-end mt-2">
      <button type="button" class="btn btn-ghost" @click="emit('cancel')">
        Cancel
      </button>
      <button
        type="submit"
        class="btn btn-primary"
        :disabled="!isValid || mutations.isLoading.value"
      >
        <span v-if="mutations.isLoading.value" class="loading loading-spinner loading-sm" />
        Save Changes
      </button>
    </div>
  </form>
</template>

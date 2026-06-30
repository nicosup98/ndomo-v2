<script setup lang="ts">
/**
 * CreatePlanForm — daisyUI form for creating a new plan.
 *
 * Validates client-side before calling usePlanMutations().create().
 * Emits `created` with the Plan on success, `cancel` on abort.
 */
import { ref, computed } from "vue";
import { usePlanMutations } from "@/composables/usePlanMutations";
import type { Plan, PlanCreateBody, PlanCategory, PlanOwner } from "@/types/api";

const emit = defineEmits<{
  created: [plan: Plan];
  cancel: [];
}>();

const mutations = usePlanMutations();

// ─── Form state ─────────────────────────────────────────────────────────────

const slug = ref("");
const title = ref("");
const overview = ref("");
const approach = ref("");
const priority = ref(5);
const complexity = ref(3);
const category = ref<PlanCategory>("feature");
const owner = ref<PlanOwner>("craftsman");

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const slugError = computed(() => {
  if (!slug.value) return "Slug is required";
  if (!slugPattern.test(slug.value)) return "Lowercase letters, numbers, hyphens only (e.g. my-plan)";
  return null;
});

const titleError = computed(() => {
  if (!title.value.trim()) return "Title is required";
  return null;
});

const overviewError = computed(() => {
  if (!overview.value.trim()) return "Overview is required";
  if (overview.value.trim().length < 10) return "Overview must be at least 10 characters";
  return null;
});

const isValid = computed(() => !slugError.value && !titleError.value && !overviewError.value);

// ─── Submit ─────────────────────────────────────────────────────────────────

async function handleSubmit(): Promise<void> {
  if (!isValid.value) return;

  const body: PlanCreateBody = {
    slug: slug.value.trim(),
    title: title.value.trim(),
    overview: overview.value.trim(),
    createdBy: owner.value,
    priority: priority.value,
    complexity: complexity.value,
    category: category.value,
    owner: owner.value,
  };
  if (approach.value.trim()) {
    body.approach = approach.value.trim();
  }

  try {
    const plan = await mutations.create(body);
    emit("created", plan);
  } catch {
    // error is already in mutations.error — displayed in template
  }
}
</script>

<template>
  <form @submit.prevent="handleSubmit" class="flex flex-col gap-4">
    <!-- Error alert -->
    <div v-if="mutations.error.value" role="alert" class="alert alert-error">
      <span>{{ mutations.error.value }}</span>
    </div>

    <!-- Slug -->
    <fieldset class="fieldset">
      <legend class="fieldset-legend">Slug *</legend>
      <input
        v-model="slug"
        type="text"
        placeholder="my-plan"
        class="input input-bordered w-full"
        :class="{ 'input-error': slugError }"
        required
      />
      <p v-if="slugError" class="label text-error">{{ slugError }}</p>
    </fieldset>

    <!-- Title -->
    <fieldset class="fieldset">
      <legend class="fieldset-legend">Title *</legend>
      <input
        v-model="title"
        type="text"
        placeholder="Plan title"
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
        placeholder="Describe the plan (min 10 characters)"
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
        placeholder="Implementation approach (optional)"
        class="textarea textarea-bordered w-full"
        rows="3"
      />
    </fieldset>

    <!-- Priority + Complexity + Category + Owner row -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
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

      <fieldset class="fieldset">
        <legend class="fieldset-legend">Owner</legend>
        <select v-model="owner" class="select select-bordered w-full">
          <option value="craftsman">craftsman</option>
          <option value="foreman">foreman</option>
          <option value="warden">warden</option>
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
        Create Plan
      </button>
    </div>
  </form>
</template>

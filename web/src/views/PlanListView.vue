<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useApi } from "@/composables/useApi";
import { useSseRefresh } from "@/composables/useSseRefresh";
import { listPlans } from "@/api/plans";
import type { PlanStatus } from "@/types/api";
import PlanListItem from "@/components/PlanListItem.vue";
import LoadingSpinner from "@/components/LoadingSpinner.vue";
import ErrorState from "@/components/ErrorState.vue";

const router = useRouter();
const statusFilter = ref<PlanStatus | "">("");

const plans = useApi(() => {
  const s = statusFilter.value;
  return s ? listPlans({ status: s as PlanStatus }) : listPlans();
});

// SSE: refresh on any plan event
const { status: sseStatus } = useSseRefresh({
  events: ["plan.created", "plan.updated", "plan.status_changed", "plan.archived"],
  refreshKey: "/api/plans",
  refresh: plans.refresh,
});

function handleRowClick(id: string): void {
  router.push(`/plans/${id}`);
}

const statuses: Array<{ value: PlanStatus | ""; label: string }> = [
  { value: "", label: "all" },
  { value: "draft", label: "draft" },
  { value: "approved", label: "approved" },
  { value: "executing", label: "executing" },
  { value: "completed", label: "completed" },
  { value: "failed", label: "failed" },
  { value: "abandoned", label: "abandoned" },
];
</script>

<template>
  <section class="section">
    <div class="level">
      <div class="level-left">
        <div class="level-item">
          <h1 class="title">plans</h1>
        </div>
      </div>
      <div class="level-right">
        <div class="level-item">
          <router-link to="/plans/new" class="btn btn-primary btn-sm">
            + Create Plan
          </router-link>
        </div>
        <div class="level-item">
          <div class="field has-addons">
            <div class="control">
              <span class="button is-static is-small">status</span>
            </div>
            <div class="control">
              <div class="select is-small">
                <select v-model="statusFilter" @change="plans.refresh()">
                  <option v-for="s in statuses" :key="s.value" :value="s.value">
                    {{ s.label }}
                  </option>
                </select>
              </div>
            </div>
          </div>
        </div>
        <div class="level-item">
          <button
            class="button is-small is-outlined"
            :class="{ 'is-loading': plans.loading.value }"
            :disabled="plans.loading.value"
            @click="plans.refresh()"
          >
            refresh
          </button>
        </div>
        <div class="level-item">
          <span
            class="icon is-small has-text-grey-light"
            :title="`SSE: ${sseStatus}`"
            aria-label="SSE connection status"
          >
            <span
              class="is-sse-dot"
              :class="{
                'has-background-success': sseStatus === 'OPEN',
                'has-background-warning': sseStatus === 'CONNECTING',
                'has-background-danger': sseStatus === 'CLOSED',
              }"
            />
          </span>
        </div>
      </div>
    </div>

    <LoadingSpinner v-if="plans.loading.value && !plans.data.value" />
    <ErrorState
      v-else-if="plans.error.value"
      :message="plans.error.value.message"
      retryable
      @retry="plans.refresh"
    />
    <div v-else>
      <table class="table is-hoverable is-fullwidth">
        <thead>
          <tr>
            <th>plan</th>
            <th>status</th>
            <th class="has-text-centered">pri</th>
            <th class="has-text-centered">cx</th>
            <th class="has-text-right">updated</th>
          </tr>
        </thead>
        <tbody>
          <PlanListItem
            v-for="plan in plans.data.value"
            :key="plan.id"
            :plan="plan"
            @click="handleRowClick"
          />
        </tbody>
      </table>
      <p v-if="plans.data.value && plans.data.value.length === 0" class="has-text-centered has-text-grey py-6">
        no plans found
      </p>
    </div>
  </section>
</template>

<style scoped>
.is-sse-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transition: background 0.2s;
}
</style>

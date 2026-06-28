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
  <div class="plan-list-view">
    <div class="toolbar">
      <div class="filters">
        <label class="filter-label">status</label>
        <select v-model="statusFilter" class="filter-select" @change="plans.refresh()">
          <option v-for="s in statuses" :key="s.value" :value="s.value">
            {{ s.label }}
          </option>
        </select>
      </div>
      <button class="refresh-btn" :disabled="plans.loading.value" @click="plans.refresh()">
        refresh
      </button>
      <span
        class="sse-dot"
        :class="{
          'sse-open': sseStatus === 'OPEN',
          'sse-connecting': sseStatus === 'CONNECTING',
          'sse-closed': sseStatus === 'CLOSED',
        }"
        :title="`SSE: ${sseStatus}`"
        aria-label="SSE connection status"
      />
    </div>

    <LoadingSpinner v-if="plans.loading.value && !plans.data.value" />
    <ErrorState
      v-else-if="plans.error.value"
      :message="plans.error.value.message"
      retryable
      @retry="plans.refresh"
    />
    <div v-else class="table-wrap">
      <table class="plans-table">
        <thead>
          <tr>
            <th>plan</th>
            <th>status</th>
            <th>pri</th>
            <th>cx</th>
            <th>updated</th>
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
      <p v-if="plans.data.value && plans.data.value.length === 0" class="muted empty-msg">
        no plans found
      </p>
    </div>
  </div>
</template>

<style scoped>
.plan-list-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.filters {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.filter-label {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.filter-select {
  font-size: var(--fs-sm);
  padding: var(--space-1) var(--space-2);
  min-width: 120px;
}
.refresh-btn {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.table-wrap {
  overflow-x: auto;
}
.plans-table {
  width: 100%;
  border-collapse: collapse;
}
th {
  text-align: left;
  padding: var(--space-2) var(--space-3);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
}
.empty-msg {
  text-align: center;
  padding: var(--space-6);
}
.sse-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background var(--t-base);
}
.sse-open { background: var(--status-done); }
.sse-connecting { background: var(--status-blocked); animation: sse-pulse 1.5s ease-in-out infinite; }
.sse-closed { background: var(--status-failed); }
@keyframes sse-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>

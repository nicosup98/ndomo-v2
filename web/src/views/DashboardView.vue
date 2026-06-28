<script setup lang="ts">
import { useApi } from "@/composables/useApi";
import { useSseRefresh } from "@/composables/useSseRefresh";
import { listPlans } from "@/api/plans";
import { apiGet } from "@/api/client";
import type { Health, Plan } from "@/types/api";
import StatusBadge from "@/components/StatusBadge.vue";
import LoadingSpinner from "@/components/LoadingSpinner.vue";
import ErrorState from "@/components/ErrorState.vue";
import { useTimeAgo } from "@vueuse/core";

const health = useApi<Health>(() => apiGet<Health>("/health"));
const plans = useApi<Plan[]>(() => listPlans({ limit: 5 }));

// SSE: refresh on any plan/task/session event
const { status: sseStatus } = useSseRefresh({
  events: [
    "plan.created", "plan.updated", "plan.status_changed", "plan.archived",
    "task.created", "task.updated", "task.status_changed",
    "session.started", "session.checkpoint", "session.ended",
  ],
  refreshKey: "/api/health",
  refresh: () => { health.refresh(); plans.refresh(); },
});

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function TimeAgo({ timestamp }: { timestamp: number }) {
  const ago = useTimeAgo(() => timestamp);
  return ago.value;
}
</script>

<template>
  <div class="dashboard">
    <section class="health-section">
      <div class="section-header">
        <h2 class="section-title">server</h2>
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
      <LoadingSpinner v-if="health.loading.value" />
      <ErrorState
        v-else-if="health.error.value"
        :message="health.error.value.message"
        retryable
        @retry="health.refresh"
      />
      <div v-else-if="health.data.value" class="health-grid">
        <div class="health-item">
          <span class="label">status</span>
          <span :class="health.data.value.status === 'ok' ? 'val-ok' : 'val-warn'">
            {{ health.data.value.status }}
          </span>
        </div>
        <div class="health-item">
          <span class="label">version</span>
          <span class="val">{{ health.data.value.version }}</span>
        </div>
        <div class="health-item">
          <span class="label">uptime</span>
          <span class="val">{{ formatUptime(health.data.value.uptime) }}</span>
        </div>
        <div class="health-item">
          <span class="label">db</span>
          <span :class="health.data.value.dbHealthy ? 'val-ok' : 'val-warn'">
            {{ health.data.value.dbHealthy ? "ok" : "degraded" }}
          </span>
        </div>
      </div>
    </section>

    <section class="plans-section">
      <div class="section-header">
        <h2 class="section-title">recent plans</h2>
        <router-link to="/plans" class="view-all">view all</router-link>
      </div>
      <LoadingSpinner v-if="plans.loading.value" />
      <ErrorState
        v-else-if="plans.error.value"
        :message="plans.error.value.message"
        retryable
        @retry="plans.refresh"
      />
      <table v-else-if="plans.data.value && plans.data.value.length > 0" class="plans-table">
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
          <tr
            v-for="plan in plans.data.value"
            :key="plan.id"
            class="plan-row"
            tabindex="0"
            role="link"
            @click="$router.push(`/plans/${plan.id}`)"
            @keydown.enter="$router.push(`/plans/${plan.id}`)"
          >
            <td class="cell-title">{{ plan.slug }}</td>
            <td><StatusBadge :status="plan.status" /></td>
            <td class="cell-num">{{ plan.priority }}</td>
            <td class="cell-num">{{ plan.complexity }}</td>
            <td class="cell-time muted">{{ useTimeAgo(plan.updatedAt).value }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">no plans yet</p>
    </section>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.section-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.view-all {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-3);
}
.health-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-3);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
}
.label {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.val {
  font-size: var(--fs-md);
  font-weight: var(--fw-medium);
  color: var(--text-primary);
}
.val-ok { color: var(--status-done); font-size: var(--fs-md); font-weight: var(--fw-medium); }
.val-warn { color: var(--status-failed); font-size: var(--fs-md); font-weight: var(--fw-medium); }
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
}
.cell-title {
  font-weight: var(--fw-medium);
  color: var(--text-primary);
}
.cell-num {
  text-align: center;
  width: 50px;
}
.cell-time {
  text-align: right;
  white-space: nowrap;
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

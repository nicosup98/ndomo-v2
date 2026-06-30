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
</script>

<template>
  <section class="section">
    <div class="level mb-5">
      <div class="level-left">
        <h2 class="title is-4">server</h2>
      </div>
      <div class="level-right">
        <span
          class="icon is-small"
          :title="`SSE: ${sseStatus}`"
          aria-label="SSE connection status"
        >
          <span
            style="display:inline-block;width:10px;height:10px;border-radius:50%;"
            :style="{
              background: sseStatus === 'OPEN' ? 'var(--status-done)' : sseStatus === 'CONNECTING' ? 'var(--status-blocked)' : 'var(--status-failed)',
            }"
          />
        </span>
      </div>
    </div>

    <LoadingSpinner v-if="health.loading.value" />
    <ErrorState
      v-else-if="health.error.value"
      :message="health.error.value.message"
      retryable
      @retry="health.refresh"
    />
    <div v-else-if="health.data.value" class="columns is-multiline">
      <div class="column is-one-quarter">
        <div class="card">
          <div class="card-content has-text-centered">
            <p class="heading">status</p>
            <p class="title" :class="health.data.value.status === 'ok' ? 'has-text-success' : 'has-text-danger'">
              {{ health.data.value.status }}
            </p>
          </div>
        </div>
      </div>
      <div class="column is-one-quarter">
        <div class="card">
          <div class="card-content has-text-centered">
            <p class="heading">version</p>
            <p class="title">{{ health.data.value.version }}</p>
          </div>
        </div>
      </div>
      <div class="column is-one-quarter">
        <div class="card">
          <div class="card-content has-text-centered">
            <p class="heading">uptime</p>
            <p class="title">{{ formatUptime(health.data.value.uptime) }}</p>
          </div>
        </div>
      </div>
      <div class="column is-one-quarter">
        <div class="card">
          <div class="card-content has-text-centered">
            <p class="heading">db</p>
            <p class="title" :class="health.data.value.dbHealthy ? 'has-text-success' : 'has-text-danger'">
              {{ health.data.value.dbHealthy ? "ok" : "degraded" }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <div class="level mt-6 mb-4">
      <div class="level-left">
        <h2 class="title is-4">recent plans</h2>
      </div>
      <div class="level-right">
        <router-link to="/plans" class="button is-small is-link is-light">view all</router-link>
      </div>
    </div>

    <LoadingSpinner v-if="plans.loading.value" />
    <ErrorState
      v-else-if="plans.error.value"
      :message="plans.error.value.message"
      retryable
      @retry="plans.refresh"
    />
    <div v-else-if="plans.data.value && plans.data.value.length > 0" class="table-container">
      <table class="table is-fullwidth is-hoverable is-striped">
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
          <tr
            v-for="plan in plans.data.value"
            :key="plan.id"
            class="is-clickable"
            tabindex="0"
            role="link"
            @click="$router.push(`/plans/${plan.id}`)"
            @keydown.enter="$router.push(`/plans/${plan.id}`)"
          >
            <td><strong>{{ plan.slug }}</strong></td>
            <td><StatusBadge :status="plan.status" /></td>
            <td class="has-text-centered">{{ plan.priority }}</td>
            <td class="has-text-centered">{{ plan.complexity }}</td>
            <td class="has-text-right has-text-grey">{{ useTimeAgo(plan.updatedAt).value }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="has-text-grey has-text-centered">no plans yet</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useApi } from "@/composables/useApi";
import { getPlan } from "@/api/plans";
import { listTasks } from "@/api/tasks";
import type { Task, TaskStatus } from "@/types/api";
import StatusBadge from "@/components/StatusBadge.vue";
import TaskRow from "@/components/TaskRow.vue";
import LoadingSpinner from "@/components/LoadingSpinner.vue";
import ErrorState from "@/components/ErrorState.vue";
import { useRouter } from "vue-router";
import { useTimeAgo } from "@vueuse/core";

const props = defineProps<{
  id: string;
}>();

const router = useRouter();
const plan = useApi(() => getPlan(props.id));
const tasks = useApi(() => listTasks(props.id));

const groupedTasks = computed(() => {
  if (!tasks.data.value) return null;
  const groups: Record<TaskStatus, Task[]> = {
    running: [],
    pending: [],
    done: [],
    failed: [],
    blocked: [],
  };
  for (const t of tasks.data.value) {
    groups[t.status].push(t);
  }
  return groups;
});

function handleTaskClick(taskId: string): void {
  router.push(`/tasks/${taskId}`);
}
</script>

<template>
  <div class="plan-detail">
    <LoadingSpinner v-if="plan.loading.value && !plan.data.value" />
    <ErrorState
      v-else-if="plan.error.value"
      :message="plan.error.value.message"
      retryable
      @retry="plan.refresh"
    />
    <template v-else-if="plan.data.value">
      <section class="plan-meta">
        <div class="meta-header">
          <h2 class="plan-title">{{ plan.data.value.title }}</h2>
          <StatusBadge :status="plan.data.value.status" />
        </div>
        <p class="plan-slug muted">{{ plan.data.value.slug }}</p>
        <p class="plan-overview">{{ plan.data.value.overview }}</p>
        <div class="meta-grid">
          <div class="meta-item">
            <span class="label">priority</span>
            <span class="val">{{ plan.data.value.priority }}</span>
          </div>
          <div class="meta-item">
            <span class="label">complexity</span>
            <span class="val">{{ plan.data.value.complexity }}</span>
          </div>
          <div class="meta-item">
            <span class="label">created</span>
            <span class="val">{{ useTimeAgo(plan.data.value.createdAt).value }}</span>
          </div>
          <div class="meta-item">
            <span class="label">updated</span>
            <span class="val">{{ useTimeAgo(plan.data.value.updatedAt).value }}</span>
          </div>
          <div v-if="plan.data.value.createdBy" class="meta-item">
            <span class="label">created by</span>
            <span class="val">{{ plan.data.value.createdBy }}</span>
          </div>
          <div v-if="plan.data.value.executedByAgent" class="meta-item">
            <span class="label">executed by</span>
            <span class="val">{{ plan.data.value.executedByAgent }}</span>
          </div>
        </div>
        <div v-if="plan.data.value.approach" class="approach">
          <span class="label">approach</span>
          <pre class="approach-text">{{ plan.data.value.approach }}</pre>
        </div>
      </section>

      <section class="tasks-section">
        <h3 class="section-title">tasks</h3>
        <LoadingSpinner v-if="tasks.loading.value && !tasks.data.value" />
        <ErrorState
          v-else-if="tasks.error.value"
          :message="tasks.error.value.message"
          retryable
          @retry="tasks.refresh"
        />
        <template v-else-if="groupedTasks">
          <div
            v-for="status in (['running', 'pending', 'failed', 'blocked', 'done'] as TaskStatus[])"
            :key="status"
            class="task-group"
          >
            <template v-if="groupedTasks[status].length > 0">
              <h4 class="group-label">
                {{ status }}
                <span class="group-count">{{ groupedTasks[status].length }}</span>
              </h4>
              <table class="tasks-table">
                <thead>
                  <tr>
                    <th>status</th>
                    <th>agent</th>
                    <th>description</th>
                    <th>duration</th>
                  </tr>
                </thead>
                <tbody>
                  <TaskRow
                    v-for="task in groupedTasks[status]"
                    :key="task.id"
                    :task="task"
                    @click="handleTaskClick"
                  />
                </tbody>
              </table>
            </template>
          </div>
          <p
            v-if="tasks.data.value?.length === 0"
            class="muted"
            style="text-align: center; padding: var(--space-6)"
          >
            no tasks
          </p>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.plan-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.plan-meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
}
.meta-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.plan-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.plan-slug {
  margin: 0;
  font-size: var(--fs-xs);
}
.plan-overview {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: var(--lh-relaxed);
}
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-3);
}
.meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.label {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.val {
  font-size: var(--fs-sm);
  color: var(--text-primary);
}
.approach {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.approach-text {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-elevated);
  padding: var(--space-3);
  border-radius: var(--r-sm);
  max-height: 300px;
  overflow-y: auto;
}
.section-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.tasks-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.task-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.group-label {
  margin: 0;
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.group-count {
  font-size: var(--fs-xs);
  color: var(--text-disabled);
}
.tasks-table {
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
</style>

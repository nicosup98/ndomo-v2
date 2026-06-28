<script setup lang="ts">
import { useApi } from "@/composables/useApi";
import { useSseRefresh } from "@/composables/useSseRefresh";
import { getTask } from "@/api/tasks";
import StatusBadge from "@/components/StatusBadge.vue";
import LoadingSpinner from "@/components/LoadingSpinner.vue";
import ErrorState from "@/components/ErrorState.vue";
import { useTimeAgo } from "@vueuse/core";

const props = defineProps<{
  id: string;
}>();

const task = useApi(() => getTask(props.id));

// SSE: refresh on task.* events matching this taskId
useSseRefresh({
  events: ["task.created", "task.updated", "task.status_changed"],
  refreshKey: `/api/tasks/${props.id}`,
  refresh: task.refresh,
  filter: (p) => {
    const payload = p as Record<string, unknown>;
    return payload?.taskId === props.id;
  },
});

function formatDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
</script>

<template>
  <div class="task-detail">
    <LoadingSpinner v-if="task.loading.value && !task.data.value" />
    <ErrorState
      v-else-if="task.error.value"
      :message="task.error.value.message"
      retryable
      @retry="task.refresh"
    />
    <template v-else-if="task.data.value">
      <section class="task-meta">
        <div class="meta-header">
          <StatusBadge :status="task.data.value.status" />
          <span class="agent mono">{{ task.data.value.agent }}</span>
        </div>
        <p class="task-desc">{{ task.data.value.description }}</p>
        <div class="meta-grid">
          <div class="meta-item">
            <span class="label">order</span>
            <span class="val">{{ task.data.value.orderIndex }}</span>
          </div>
          <div class="meta-item">
            <span class="label">complexity</span>
            <span class="val">{{ task.data.value.complexity }}</span>
          </div>
          <div class="meta-item">
            <span class="label">duration</span>
            <span class="val">{{ formatDuration(task.data.value.durationMs) }}</span>
          </div>
          <div class="meta-item">
            <span class="label">started</span>
            <span class="val">{{ task.data.value.startedAt ? useTimeAgo(task.data.value.startedAt).value : "-" }}</span>
          </div>
          <div class="meta-item">
            <span class="label">completed</span>
            <span class="val">{{ task.data.value.completedAt ? useTimeAgo(task.data.value.completedAt).value : "-" }}</span>
          </div>
          <div v-if="task.data.value.createdBy" class="meta-item">
            <span class="label">created by</span>
            <span class="val">{{ task.data.value.createdBy }}</span>
          </div>
        </div>
        <div v-if="task.data.value.files.length > 0" class="files-section">
          <span class="label">files</span>
          <ul class="file-list">
            <li v-for="f in task.data.value.files" :key="f" class="file-item mono">{{ f }}</li>
          </ul>
        </div>
        <div v-if="task.data.value.dependencies.length > 0" class="deps-section">
          <span class="label">dependencies</span>
          <ul class="dep-list">
            <li v-for="d in task.data.value.dependencies" :key="d" class="dep-item mono">{{ d }}</li>
          </ul>
        </div>
      </section>

      <section v-if="task.data.value.result" class="result-section">
        <h3 class="section-title">result</h3>
        <pre class="result-text">{{ task.data.value.result }}</pre>
      </section>

      <section v-if="task.data.value.error" class="error-section">
        <h3 class="section-title">error</h3>
        <pre class="error-text">{{ task.data.value.error }}</pre>
      </section>
    </template>
  </div>
</template>

<style scoped>
.task-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.task-meta {
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
.agent {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.task-desc {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-primary);
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
.files-section,
.deps-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.file-list,
.dep-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.file-item,
.dep-item {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  padding: var(--space-1) var(--space-2);
  background: var(--bg-elevated);
  border-radius: var(--r-sm);
}
.section-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.result-section,
.error-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.result-text,
.error-text {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  padding: var(--space-3);
  border-radius: var(--r-sm);
  max-height: 400px;
  overflow-y: auto;
}
.result-text {
  color: var(--text-secondary);
}
.error-text {
  color: var(--status-failed);
}
</style>

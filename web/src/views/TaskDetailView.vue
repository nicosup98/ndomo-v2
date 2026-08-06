<script setup lang="ts">
import { useApi } from "@/composables/useApi";
import { useSseRefresh } from "@/composables/useSseRefresh";
import { getTask } from "@/api/tasks";
import StatusBadge from "@/components/StatusBadge.vue";
import LoadingSpinner from "@/components/LoadingSpinner.vue";
import ErrorState from "@/components/ErrorState.vue";
import StatusActions from "@/components/StatusActions.vue";
import AgentReassignDropdown from "@/components/AgentReassignDropdown.vue";
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
  <section class="section">
    <LoadingSpinner v-if="task.loading.value && !task.data.value" />
    <ErrorState
      v-else-if="task.error.value"
      :message="task.error.value.message"
      retryable
      @retry="task.refresh"
    />
    <template v-else-if="task.data.value">
      <div class="card">
        <header class="card-header">
          <p class="card-header-title">
            <StatusBadge :status="task.data.value.status" />
            <span class="tag is-info is-light ml-3">{{ task.data.value.agent }}</span>
          </p>
        </header>
        <div class="card-content">
          <p class="subtitle is-6 mb-4">{{ task.data.value.description }}</p>

          <div class="columns is-multiline">
            <div class="column is-half">
              <p class="heading">order</p>
              <p class="title is-5">{{ task.data.value.orderIndex }}</p>
            </div>
            <div class="column is-half">
              <p class="heading">complexity</p>
              <p class="title is-5">{{ task.data.value.complexity }}</p>
            </div>
            <div class="column is-half">
              <p class="heading">duration</p>
              <p class="title is-5">{{ formatDuration(task.data.value.durationMs) }}</p>
            </div>
            <div class="column is-half">
              <p class="heading">started</p>
              <p class="title is-5">{{ task.data.value.startedAt ? useTimeAgo(task.data.value.startedAt).value : "-" }}</p>
            </div>
            <div class="column is-half">
              <p class="heading">completed</p>
              <p class="title is-5">{{ task.data.value.completedAt ? useTimeAgo(task.data.value.completedAt).value : "-" }}</p>
            </div>
            <div v-if="task.data.value.createdBy" class="column is-half">
              <p class="heading">created by</p>
              <p class="title is-5">{{ task.data.value.createdBy }}</p>
            </div>
          </div>

          <div v-if="task.data.value.files.length > 0" class="mt-4">
            <p class="heading mb-2">files</p>
            <div class="tags">
              <span v-for="f in task.data.value.files" :key="f" class="tag is-family-monospace">{{ f }}</span>
            </div>
          </div>

          <div v-if="task.data.value.dependencies.length > 0" class="mt-4">
            <p class="heading mb-2">dependencies</p>
            <div class="tags">
              <span v-for="d in task.data.value.dependencies" :key="d" class="tag is-warning is-light is-family-monospace">{{ d }}</span>
            </div>
          </div>
        </div>
      </div>

      <article v-if="task.data.value.result" class="message is-success mt-5">
        <div class="message-header">
          <p>result</p>
        </div>
        <div class="message-body">
          <pre class="is-family-monospace" style="white-space: pre-wrap; word-break: break-word;">{{ task.data.value.result }}</pre>
        </div>
      </article>

      <article v-if="task.data.value.error" class="message is-danger mt-5">
        <div class="message-header">
          <p>error</p>
        </div>
        <div class="message-body">
          <pre class="is-family-monospace" style="white-space: pre-wrap; word-break: break-word;">{{ task.data.value.error }}</pre>
        </div>
      </article>

      <!-- Task Actions -->
      <div class="mt-5 flex gap-2 flex-wrap items-start">
        <StatusActions kind="task" :task="task.data.value" @changed="task.refresh()" />
        <AgentReassignDropdown
          v-if="task.data.value.status === 'pending' || task.data.value.status === 'running'"
          :taskId="task.data.value.id"
          :currentAgent="task.data.value.agent"
          @reassigned="task.refresh()"
        />
      </div>
    </template>
  </section>
</template>

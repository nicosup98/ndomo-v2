<script setup lang="ts">
import { computed } from "vue";
import { useApi } from "@/composables/useApi";
import { useSseRefresh } from "@/composables/useSseRefresh";
import { getPlan } from "@/api/plans";
import { listTasks } from "@/api/tasks";
import type { Task, TaskStatus } from "@/types/api";
import StatusBadge from "@/components/StatusBadge.vue";
import TaskRow from "@/components/TaskRow.vue";
import LoadingSpinner from "@/components/LoadingSpinner.vue";
import ErrorState from "@/components/ErrorState.vue";
import EditPlanForm from "@/components/EditPlanForm.vue";
import StatusActions from "@/components/StatusActions.vue";
import CreateTaskForm from "@/components/CreateTaskForm.vue";
import { useRouter } from "vue-router";
import { useTimeAgo } from "@vueuse/core";

const props = defineProps<{
  id: string;
}>();

const router = useRouter();
const plan = useApi(() => getPlan(props.id));
const tasks = useApi(() => listTasks(props.id));

// SSE: refresh plan on plan.* events matching this id
useSseRefresh({
  events: ["plan.created", "plan.updated", "plan.status_changed", "plan.archived"],
  refreshKey: `/api/plans/${props.id}`,
  refresh: plan.refresh,
  filter: (p) => {
    const payload = p as Record<string, unknown>;
    return payload?.planId === props.id;
  },
});

// SSE: refresh tasks on task.* events matching this planId
useSseRefresh({
  events: ["task.created", "task.updated", "task.status_changed"],
  refreshKey: `/api/plans/${props.id}/tasks`,
  refresh: tasks.refresh,
  filter: (p) => {
    const payload = p as Record<string, unknown>;
    return payload?.planId === props.id;
  },
});

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
  <section class="section">
    <!-- Breadcrumb -->
    <nav class="breadcrumb mb-4" aria-label="breadcrumbs">
      <ul>
        <li><router-link :to="{ name: 'plans' }">plans</router-link></li>
        <li class="is-active">
          <a href="#" aria-current="page">{{ plan.data.value?.slug ?? props.id }}</a>
        </li>
      </ul>
    </nav>

    <LoadingSpinner v-if="plan.loading.value && !plan.data.value" />
    <ErrorState
      v-else-if="plan.error.value"
      :message="plan.error.value.message"
      retryable
      @retry="plan.refresh"
    />
    <template v-else-if="plan.data.value">
      <!-- Plan header card -->
      <div class="card mb-5">
        <header class="card-header">
          <p class="card-header-title">
            {{ plan.data.value.title }}
            <StatusBadge :status="plan.data.value.status" class="ml-3" />
          </p>
        </header>
        <div class="card-content">
          <p class="has-text-grey is-size-7 mb-2">{{ plan.data.value.slug }}</p>
          <p class="mb-4">{{ plan.data.value.overview }}</p>

          <div class="columns is-multiline">
            <div class="column is-one-third">
              <p class="heading">priority</p>
              <p class="title is-5">{{ plan.data.value.priority }}</p>
            </div>
            <div class="column is-one-third">
              <p class="heading">complexity</p>
              <p class="title is-5">{{ plan.data.value.complexity }}</p>
            </div>
            <div class="column is-one-third">
              <p class="heading">created</p>
              <p class="title is-5">{{ useTimeAgo(plan.data.value.createdAt).value }}</p>
            </div>
            <div class="column is-one-third">
              <p class="heading">updated</p>
              <p class="title is-5">{{ useTimeAgo(plan.data.value.updatedAt).value }}</p>
            </div>
            <div v-if="plan.data.value.createdBy" class="column is-one-third">
              <p class="heading">created by</p>
              <p class="title is-5">{{ plan.data.value.createdBy }}</p>
            </div>
            <div v-if="plan.data.value.executedByAgent" class="column is-one-third">
              <p class="heading">executed by</p>
              <p class="title is-5">{{ plan.data.value.executedByAgent }}</p>
            </div>
          </div>

          <div v-if="plan.data.value.approach" class="mt-4">
            <p class="heading mb-2">approach</p>
            <pre class="box has-background-dark has-text-light is-size-7" style="white-space: pre-wrap; max-height: 300px; overflow-y: auto;">{{ plan.data.value.approach }}</pre>
          </div>
        </div>
      </div>

      <!-- Status Actions -->
      <div class="mb-5">
        <StatusActions kind="plan" :plan="plan.data.value" @changed="plan.refresh()" />
      </div>

      <!-- Edit Plan (collapsible) -->
      <details class="mb-5">
        <summary class="title is-5 mb-3" style="cursor: pointer;">Edit Plan</summary>
        <div class="box">
          <EditPlanForm
            :plan="plan.data.value"
            @updated="plan.refresh()"
            @cancel="() => {}"
          />
        </div>
      </details>

      <!-- Add Task -->
      <details class="mb-5">
        <summary class="title is-5 mb-3" style="cursor: pointer;">Add Task</summary>
        <div class="box">
          <CreateTaskForm
            :planId="plan.data.value.id"
            @created="tasks.refresh()"
            @cancel="() => {}"
          />
        </div>
      </details>

      <!-- Tasks section -->
      <h3 class="title is-4 mb-3">tasks</h3>
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
          class="mb-4"
        >
          <template v-if="groupedTasks[status].length > 0">
            <h4 class="subtitle is-6 has-text-grey mb-2">
              {{ status }}
              <span class="tag is-small is-light ml-2">{{ groupedTasks[status].length }}</span>
            </h4>
            <table class="table is-hoverable is-fullwidth">
              <thead>
                <tr>
                  <th>status</th>
                  <th>agent</th>
                  <th>description</th>
                  <th class="has-text-right">duration</th>
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
          class="has-text-centered has-text-grey py-6"
        >
          no tasks
        </p>
      </template>
    </template>
  </section>
</template>

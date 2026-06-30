<script setup lang="ts">
import { useRoute } from "vue-router";
import { computed, ref } from "vue";
import { useSseRefresh } from "@/composables/useSseRefresh";

const route = useRoute();
const menuOpen = ref(false);

// Global SSE status indicator — singleton, no extra connection
const { status: sseStatus } = useSseRefresh({
  events: ["hello"],
  refreshKey: "__appshell_status__",
  refresh: () => {},
});

const pageTitle = computed(() => {
  const name = route.name;
  if (name === "dashboard") return "dashboard";
  if (name === "plans") return "plans";
  if (name === "plan-detail") return "plan detail";
  if (name === "task-detail") return "task detail";
  return "ndomo";
});
</script>

<template>
  <nav class="navbar is-dark has-shadow" role="navigation" aria-label="main navigation">
    <div class="navbar-brand">
      <router-link to="/" class="navbar-item has-text-weight-bold is-size-5" @click="menuOpen = false">
        ndomo
      </router-link>
      <a
        role="button"
        class="navbar-burger"
        :class="{ 'is-active': menuOpen }"
        aria-label="menu"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
        <span aria-hidden="true"></span>
      </a>
    </div>

    <div class="navbar-menu" :class="{ 'is-active': menuOpen }">
      <div class="navbar-start">
        <router-link
          to="/"
          class="navbar-item"
          :class="{ 'is-active': route.path === '/' }"
          @click="menuOpen = false"
        >
          dashboard
        </router-link>
        <router-link
          to="/plans"
          class="navbar-item"
          :class="{ 'is-active': route.path.startsWith('/plans') }"
          @click="menuOpen = false"
        >
          plans
        </router-link>
      </div>

      <div class="navbar-end">
        <div class="navbar-item">
          <span
            class="sse-dot"
            :class="{
              'sse-open': sseStatus === 'OPEN',
              'sse-connecting': sseStatus === 'CONNECTING',
              'sse-closed': sseStatus === 'CLOSED',
            }"
            :title="`Live updates: ${sseStatus}`"
            aria-label="SSE connection status"
          />
        </div>
      </div>
    </div>
  </nav>

  <section class="section py-4">
    <div class="container is-fluid">
      <h2 class="title is-5 mb-4">{{ pageTitle }}</h2>
      <slot />
    </div>
  </section>
</template>

<style scoped>
.sse-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background 0.3s;
}
.sse-open {
  background: var(--status-done);
}
.sse-connecting {
  background: var(--status-blocked);
  animation: sse-pulse 1.5s ease-in-out infinite;
}
.sse-closed {
  background: var(--status-failed);
}
@keyframes sse-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>

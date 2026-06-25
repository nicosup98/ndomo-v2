<script setup lang="ts">
import { useRoute } from "vue-router";
import { computed } from "vue";

const route = useRoute();

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
  <div class="app-shell">
    <nav class="sidebar" aria-label="Main navigation">
      <div class="sidebar-logo">
        <span class="logo-text">ndomo</span>
      </div>
      <ul class="nav-list">
        <li>
          <router-link to="/" class="nav-link" :class="{ active: route.name === 'dashboard' }">
            dashboard
          </router-link>
        </li>
        <li>
          <router-link to="/plans" class="nav-link" :class="{ active: route.name === 'plans' || route.name === 'plan-detail' }">
            plans
          </router-link>
        </li>
      </ul>
    </nav>
    <div class="main-area">
      <header class="top-header">
        <h1 class="page-title">{{ pageTitle }}</h1>
      </header>
      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  min-height: 100vh;
}
.sidebar {
  width: var(--sidebar-w);
  background: var(--bg-surface);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.sidebar-logo {
  padding: var(--space-4) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}
.logo-text {
  font-size: var(--fs-lg);
  font-weight: var(--fw-bold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-primary);
}
.nav-list {
  list-style: none;
  margin: 0;
  padding: var(--space-2) 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.nav-link {
  display: block;
  padding: var(--space-2) var(--space-4);
  font-size: var(--fs-sm);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  border-bottom: none;
  transition: color var(--t-fast), background var(--t-fast);
}
.nav-link:hover {
  color: var(--text-primary);
  background: var(--bg-elevated);
  border-bottom: none;
}
.nav-link.active {
  color: var(--text-primary);
  background: var(--bg-elevated);
}
.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.top-header {
  height: var(--header-h);
  padding: 0 var(--space-4);
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  flex-shrink: 0;
}
.page-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-primary);
}
.content {
  flex: 1;
  padding: var(--space-4);
  overflow-y: auto;
}
</style>

<script setup lang="ts">
import AppShell from "@/components/AppShell.vue";
import AuthPrompt from "@/components/AuthPrompt.vue";
import { useAuth } from "@/composables/useAuth";
import { useSseRefresh } from "@/composables/useSseRefresh";
import { useRoute } from "vue-router";
import { computed, ref, watch } from "vue";

const { isAuthed } = useAuth();
const route = useRoute();

// Global SSE status — subscribe to a dummy event to ensure the singleton is alive
const { status: sseStatus } = useSseRefresh({
  events: ["hello"],
  refreshKey: "__app_status__",
  refresh: () => {},
});

const bannerDismissed = ref(false);

// Auto-reset dismiss when SSE reconnects
watch(sseStatus, (s) => {
  if (s !== "CLOSED") bannerDismissed.value = false;
});

const showClosedBanner = computed(() => {
  if (bannerDismissed.value) return false;
  if (sseStatus.value !== "CLOSED") return false;
  return route.name === "dashboard" || route.name === "plans";
});
</script>

<template>
  <AuthPrompt v-if="!isAuthed" />
  <AppShell>
    <div v-if="showClosedBanner" class="sse-banner" role="alert">
      <span>Live updates disconnected — refresh manually</span>
      <button class="sse-banner-dismiss" @click="bannerDismissed = true">
        dismiss
      </button>
    </div>
    <router-view />
  </AppShell>
</template>

<style>
@import "@/styles/globals.css";
</style>

<style scoped>
.sse-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--status-failed);
  color: var(--text-primary);
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border-subtle);
}
.sse-banner-dismiss {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: var(--space-1) var(--space-2);
  background: transparent;
  border-color: var(--text-primary);
  color: var(--text-primary);
}
.sse-banner-dismiss:hover {
  background: rgba(255, 255, 255, 0.1);
}
</style>

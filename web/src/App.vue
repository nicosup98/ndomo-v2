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
    <div v-if="showClosedBanner" class="notification is-danger is-light mb-0" role="alert">
      <button class="delete" aria-label="dismiss" @click="bannerDismissed = true"></button>
      Live updates disconnected — refresh manually
    </div>
    <router-view />
  </AppShell>
</template>

<style>
@import "bulma/css/bulma.min.css";
@import "./styles/main.css";
</style>

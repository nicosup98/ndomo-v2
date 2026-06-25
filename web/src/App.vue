<script setup lang="ts">
import AppShell from "@/components/AppShell.vue";
import AuthPrompt from "@/components/AuthPrompt.vue";
import { useAuth } from "@/composables/useAuth";

const { isAuthed } = useAuth();
</script>

<template>
  <AuthPrompt v-if="!isAuthed" />
  <AppShell>
    <router-view />
  </AppShell>
</template>

<style>
@import "@/styles/globals.css";
</style>

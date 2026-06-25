<script setup lang="ts">
import { ref } from "vue";
import { useAuth } from "@/composables/useAuth";

const password = ref("");
const submitting = ref(false);
const error = ref<string | null>(null);
const { submitPassword } = useAuth();

async function handleSubmit(): Promise<void> {
  if (!password.value.trim()) return;
  submitting.value = true;
  error.value = null;
  submitPassword(password.value);
  password.value = "";
  submitting.value = false;
}
</script>

<template>
  <div class="auth-overlay" role="dialog" aria-modal="true" aria-label="Authentication required">
    <form class="auth-prompt" @submit.prevent="handleSubmit">
      <h2>auth required</h2>
      <p class="muted">enter OPENCODE_SERVER_PASSWORD</p>
      <input
        v-model="password"
        type="password"
        placeholder="password"
        autofocus
        :disabled="submitting"
        aria-label="Password"
      />
      <button type="submit" :disabled="submitting || !password.trim()">submit</button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>
  </div>
</template>

<style scoped>
.auth-overlay {
  position: fixed;
  inset: 0;
  background: rgba(13, 15, 18, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.auth-prompt {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  padding: var(--space-6);
  min-width: 320px;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
h2 {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-primary);
}
p { margin: 0; font-size: var(--fs-sm); }
.muted { color: var(--text-muted); }
.error { color: var(--status-failed); }
input { width: 100%; }
</style>

<script setup lang="ts">
defineProps<{
  message?: string;
  retryable?: boolean;
}>();

defineEmits<{
  retry: [];
}>();
</script>

<template>
  <div class="error-state" role="alert">
    <p class="error-msg">{{ message ?? "something went wrong" }}</p>
    <button v-if="retryable" class="retry-btn" @click="$emit('retry')">retry</button>
  </div>
</template>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-6);
}
.error-msg {
  margin: 0;
  color: var(--status-failed);
  font-size: var(--fs-sm);
  text-align: center;
}
.retry-btn {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>

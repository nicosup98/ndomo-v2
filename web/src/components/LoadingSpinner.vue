<script setup lang="ts">
defineProps<{
  size?: "sm" | "md";
}>();
</script>

<template>
  <div class="spinner" :class="size ?? 'md'" aria-label="Loading" role="status">
    <div class="spinner-ring" />
  </div>
</template>

<style scoped>
.spinner {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.spinner.sm { width: 16px; height: 16px; }
.spinner.md { width: 24px; height: 24px; }

.spinner-ring {
  width: 100%;
  height: 100%;
  border: 2px solid var(--border-subtle);
  border-top-color: var(--text-secondary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>

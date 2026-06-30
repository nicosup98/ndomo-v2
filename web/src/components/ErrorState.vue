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
  <div class="notification is-danger is-light has-text-centered" role="alert">
    <p class="mb-3">{{ message ?? "something went wrong" }}</p>
    <button v-if="retryable" class="button is-danger is-outlined is-small" @click="$emit('retry')">retry</button>
  </div>
</template>

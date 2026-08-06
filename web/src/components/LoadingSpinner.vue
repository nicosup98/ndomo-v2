<script setup lang="ts">
defineProps<{
  size?: "sm" | "md";
}>();
</script>

<template>
  <div class="has-text-centered" aria-label="Loading" role="status">
    <progress class="progress is-small is-primary" :class="size === 'sm' ? 'is-small' : ''" max="100">
      Loading...
    </progress>
  </div>
</template>

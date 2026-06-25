<template>
  <div class="not-found">
    <h1 class="code">404</h1>
    <p class="muted">page not found</p>
    <router-link to="/" class="back-link">back to dashboard</router-link>
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-12);
}
.code {
  margin: 0;
  font-size: var(--fs-xxl);
  font-weight: var(--fw-bold);
  color: var(--text-muted);
}
p {
  margin: 0;
  font-size: var(--fs-sm);
}
.back-link {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>

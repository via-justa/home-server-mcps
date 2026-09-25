<script setup lang="ts">
defineProps<{ title: string; subtitle?: string; section: string }>();
</script>

<template>
  <header class="page-header">
    <h1>{{ title }}</h1>
    <div v-if="subtitle" class="subtitle">{{ subtitle }}</div>
  </header>
  <section class="page-body">
    <div class="card">Not implemented yet — see design doc {{ section }}.</div>
  </section>
</template>

<style scoped>
.page-header {
  padding: 20px 32px;
  border-bottom: 1px solid var(--border);
}
h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
}
.subtitle {
  margin-top: 3px;
  font-size: 13px;
  color: var(--muted);
}
.page-body {
  padding: 28px 32px;
  max-width: 760px;
  font-size: 13px;
  color: var(--muted);
}
</style>

<script setup lang="ts">
import { useRoute } from 'vue-router';
import PageHeader from '../../components/PageHeader.vue';

const route = useRoute();
const tabs = [
  { path: 'mcp', label: 'MCP access' },
  { path: 'security', label: 'Sign-in & security' },
  { path: 'users', label: 'Users' },
  { path: 'notifications', label: 'Notifications' },
  { path: 'profile', label: 'My profile' },
];
</script>

<template>
  <div class="page">
    <PageHeader title="Settings" />
    <nav class="tabs">
      <RouterLink
        v-for="t in tabs"
        :key="t.path"
        :to="`/settings/${t.path}`"
        :class="{ active: route.path === `/settings/${t.path}` }"
      >
        {{ t.label }}
      </RouterLink>
    </nav>
    <RouterView />
  </div>
</template>

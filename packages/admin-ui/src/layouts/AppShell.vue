<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const app = useAppStore();
const router = useRouter();
const route = useRoute();

// Small screens: the sidebar collapses into a top bar with a menu toggle.
const menuOpen = ref(false);
watch(
  () => route.fullPath,
  () => (menuOpen.value = false),
);

const endpoints = computed(() => app.instances);

const globalNav = [
  { to: '/', label: 'Overview' },
  { to: '/approvals', label: 'Pending Approvals', badge: () => app.pendingCount },
  { to: '/audit', label: 'Audit Log' },
];
const adminNav = [
  { to: '/plugins', label: 'Plugins' },
  { to: '/clients', label: 'Clients & Tokens' },
  { to: '/settings', label: 'Settings' },
];

onMounted(() => {
  void app.refresh().catch(() => undefined);
  app.connect();
});
onBeforeUnmount(() => app.disconnect());

async function logout() {
  app.disconnect();
  await session.logout();
  await router.replace('/login');
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar" :class="{ open: menuOpen }">
      <div class="brand">
        <div class="logo">M</div>
        <div class="name">MCP Admin</div>
        <span v-if="app.pendingCount" class="badge mobile-only">{{ app.pendingCount }}</span>
        <button class="menu mobile-only" type="button" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
          {{ menuOpen ? 'Close' : 'Menu' }}
        </button>
      </div>

      <nav>
        <RouterLink v-for="item in globalNav" :key="item.to" :to="item.to" class="nav-item" exact-active-class="active">
          <span>{{ item.label }}</span>
          <span v-if="item.badge?.()" class="badge">{{ item.badge() }}</span>
        </RouterLink>

        <div class="nav-section">Endpoints</div>
        <RouterLink
          v-for="ep in endpoints"
          :key="ep.slug"
          :to="`/endpoints/${ep.slug}/connection`"
          class="nav-item mono"
          :class="{ active: $route.path.startsWith(`/endpoints/${ep.slug}/`) }"
        >
          <span>/{{ ep.slug }}</span>
          <span class="dot" :class="ep.status" :title="ep.status" />
        </RouterLink>
        <div v-if="endpoints.length === 0" class="nav-empty">No endpoints yet</div>
        <RouterLink to="/endpoints/new" class="nav-item add" exact-active-class="active">+ New endpoint</RouterLink>

        <div class="nav-section" />
        <RouterLink v-for="item in adminNav" :key="item.to" :to="item.to" class="nav-item" active-class="active">
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="footer">
        <RouterLink to="/settings/profile" class="me">{{ session.username ?? 'admin' }}</RouterLink>
        <button class="link" type="button" @click="logout">Log out</button>
      </div>
    </aside>

    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--sidebar);
  display: flex;
  flex-direction: column;
  padding: 22px 0;
}
.brand {
  padding: 0 20px 22px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.logo {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.name {
  font-size: 14px;
  font-weight: 700;
  color: #fff;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.nav-item {
  padding: 10px 20px 10px 17px;
  border-left: 3px solid transparent;
  color: var(--sidebar-text);
  font-size: 14px;
  text-decoration: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.nav-item.active {
  border-left-color: var(--accent-soft);
  background: var(--sidebar-active);
  color: #fff;
  font-weight: 600;
}
.badge {
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  border-radius: 999px;
  padding: 1px 6px;
}
.nav-section {
  margin: 16px 20px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #6f6d66;
}
.nav-empty {
  padding: 4px 20px;
  font-size: 12px;
  color: #6f6d66;
}
.footer {
  margin-top: auto;
  padding: 16px 20px 0;
  border-top: 1px solid #33353a;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--subtle);
}
.add {
  font-size: 13px;
  color: var(--subtle);
}
.me {
  color: var(--sidebar-text);
  text-decoration: none;
}
.link {
  background: none;
  border: none;
  color: var(--sidebar-text);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.menu {
  margin-left: auto;
  background: none;
  border: 1px solid #44464b;
  color: var(--sidebar-text);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}
.mobile-only {
  display: none;
}
@media (max-width: 720px) {
  .shell {
    flex-direction: column;
  }
  .sidebar {
    width: 100%;
    padding: 12px 0;
  }
  .brand {
    padding: 0 16px;
  }
  .mobile-only {
    display: inline-block;
  }
  .sidebar nav,
  .sidebar .footer {
    display: none;
  }
  .sidebar.open nav {
    display: flex;
    margin-top: 12px;
  }
  .sidebar.open .footer {
    display: flex;
    margin-top: 12px;
    padding: 12px 20px 0;
  }
}
.content {
  flex-grow: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>

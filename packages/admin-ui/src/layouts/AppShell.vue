<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const router = useRouter();

// Instances and pending-approval counts come from /api/overview once the Admin API exists (design §8.1).
const endpoints: { slug: string; status: 'ready' | 'error' | 'stopped' }[] = [];
const pendingCount = 0;

const globalNav = [
  { to: '/', label: 'Overview' },
  { to: '/approvals', label: 'Pending Approvals', badge: () => pendingCount },
  { to: '/audit', label: 'Audit Log' },
];
const adminNav = [
  { to: '/plugins', label: 'Plugins' },
  { to: '/clients', label: 'Clients & Tokens' },
  { to: '/settings', label: 'Settings' },
];

async function logout() {
  await session.logout();
  await router.replace('/login');
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo">M</div>
        <div class="name">MCP Admin</div>
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
          active-class="active"
        >
          /{{ ep.slug }}
        </RouterLink>
        <div v-if="endpoints.length === 0" class="nav-empty">No endpoints yet</div>

        <div class="nav-section" />
        <RouterLink v-for="item in adminNav" :key="item.to" :to="item.to" class="nav-item" active-class="active">
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="footer">
        <span>{{ session.username ?? 'admin' }}</span>
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
.link {
  background: none;
  border: none;
  color: var(--sidebar-text);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.content {
  flex-grow: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>

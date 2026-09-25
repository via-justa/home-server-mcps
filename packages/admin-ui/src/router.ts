import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw, RouterHistory } from 'vue-router';
import AppShell from './layouts/AppShell.vue';
import LoginView from './views/LoginView.vue';
import PlaceholderView from './views/PlaceholderView.vue';
import { useSessionStore } from './stores/session';

const page = (path: string, title: string, section: string, subtitle?: string): RouteRecordRaw => ({
  path,
  component: PlaceholderView,
  props: { title, section, subtitle },
});

const instancePage = (path: string, title: string, section: string): RouteRecordRaw => ({
  path: `endpoints/:slug/${path}`,
  component: PlaceholderView,
  props: (route) => ({ title, section, subtitle: `/${String(route.params.slug)}` }),
});

export const routes: RouteRecordRaw[] = [
  { path: '/login', component: LoginView, meta: { public: true } },
  page('/setup', 'Setup', '§6.1', 'Create the first admin account'),
  {
    path: '/',
    component: AppShell,
    children: [
      page('', 'Overview', '§8.2', 'Endpoints, plugin health and notifier health'),
      page('approvals', 'Pending Approvals', '§5.3, §8.2', 'Write calls paused on a live decision'),
      page('audit', 'Audit Log', '§8.2', 'Every call, search, config and auth event — append-only'),
      page('plugins', 'Plugins', '§4, §8.2', 'Installed, available and repositories'),
      page('clients', 'Clients & Tokens', '§6.2, §8.2', 'Bearer tokens, OAuth clients and grants'),
      page('settings', 'Settings', '§6, §9, §8.2', 'MCP access, authentication, users, notifications'),
      instancePage('connection', 'Connection', '§8.2'),
      instancePage('operations', 'Operations', '§8.2'),
      instancePage('rules', 'Pre-Approval Rules', '§5.2, §8.2'),
      instancePage('settings', 'Endpoint Settings', '§8.2'),
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  const router = createRouter({ history, routes });
  router.beforeEach(async (to) => {
    if (to.meta.public) return true;
    const session = useSessionStore();
    if (!session.loaded) await session.load();
    if (session.setupRequired && to.path !== '/setup') return '/setup';
    if (!session.authenticated && !session.setupRequired) {
      return { path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
    }
    return true;
  });
  return router;
}

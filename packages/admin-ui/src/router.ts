import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw, RouterHistory } from 'vue-router';
import { setUnauthenticatedHandler } from './api';
import AppShell from './layouts/AppShell.vue';
import { useSessionStore } from './stores/session';
import AuditView from './views/AuditView.vue';
import ClientsView from './views/ClientsView.vue';
import EnrollTotpView from './views/EnrollTotpView.vue';
import AccessView from './views/instance/AccessView.vue';
import ConnectionView from './views/instance/ConnectionView.vue';
import InstanceLayout from './views/instance/InstanceLayout.vue';
import InstanceSettingsView from './views/instance/InstanceSettingsView.vue';
import RulesView from './views/instance/RulesView.vue';
import LoginView from './views/LoginView.vue';
import NewEndpointView from './views/NewEndpointView.vue';
import OverviewView from './views/OverviewView.vue';
import PluginsView from './views/PluginsView.vue';
import McpSettingsView from './views/settings/McpSettingsView.vue';
import NotificationsView from './views/settings/NotificationsView.vue';
import ProfileView from './views/settings/ProfileView.vue';
import SecuritySettingsView from './views/settings/SecuritySettingsView.vue';
import SettingsLayout from './views/settings/SettingsLayout.vue';
import UsersView from './views/settings/UsersView.vue';
import SetupView from './views/SetupView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean;
    title?: string;
  }
}

export const routes: RouteRecordRaw[] = [
  { path: '/login', component: LoginView, meta: { public: true, title: 'Sign in' } },
  { path: '/setup', component: SetupView, meta: { public: true, title: 'Setup' } },
  { path: '/enroll-totp', component: EnrollTotpView, meta: { title: 'Two-factor setup' } },
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', component: OverviewView, meta: { title: 'Overview' } },
      { path: 'audit', component: AuditView, meta: { title: 'Audit Log' } },
      { path: 'plugins', component: PluginsView, meta: { title: 'Plugins' } },
      { path: 'clients', component: ClientsView, meta: { title: 'Clients & Tokens' } },
      { path: 'endpoints/new', component: NewEndpointView, meta: { title: 'New endpoint' } },
      {
        path: 'endpoints/:slug',
        component: InstanceLayout,
        children: [
          { path: '', redirect: (to) => `/endpoints/${String(to.params.slug)}/connection` },
          { path: 'connection', component: ConnectionView, meta: { title: 'Connection' } },
          { path: 'access', component: AccessView, meta: { title: 'Access' } },
          { path: 'rules', component: RulesView, meta: { title: 'Pre-Approval Rules' } },
          { path: 'settings', component: InstanceSettingsView, meta: { title: 'Endpoint Settings' } },
        ],
      },
      {
        path: 'settings',
        component: SettingsLayout,
        children: [
          { path: '', redirect: '/settings/mcp' },
          { path: 'mcp', component: McpSettingsView, meta: { title: 'MCP access' } },
          { path: 'security', component: SecuritySettingsView, meta: { title: 'Sign-in & security' } },
          { path: 'users', component: UsersView, meta: { title: 'Users' } },
          { path: 'notifications', component: NotificationsView, meta: { title: 'Notifications' } },
          { path: 'profile', component: ProfileView, meta: { title: 'My profile' } },
        ],
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  const router = createRouter({ history, routes });

  router.beforeEach(async (to) => {
    const session = useSessionStore();
    if (!session.loaded) await session.load();
    if (session.setupRequired) return to.path === '/setup' ? true : '/setup';
    if (to.path === '/setup') return '/';
    if (to.meta.public) return to.path === '/login' && session.authenticated ? '/' : true;
    if (!session.authenticated) {
      return { path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
    }
    if (session.mustEnrollTotp && to.path !== '/enroll-totp') return '/enroll-totp';
    return true;
  });
  router.afterEach((to) => {
    if (typeof document !== 'undefined') document.title = to.meta.title ? `${to.meta.title} · MCP Admin` : 'MCP Admin';
  });

  // A session that expires mid-use: back to the login page, keeping the current page.
  setUnauthenticatedHandler(() => {
    const session = useSessionStore();
    session.$patch({ authenticated: false, user: undefined });
    const current = router.currentRoute.value;
    if (!current.meta.public) void router.replace({ path: '/login', query: { redirect: current.fullPath } });
  });
  return router;
}

import { defineStore } from 'pinia';
import { api } from '../api';

export interface SessionState {
  loaded: boolean;
  authenticated: boolean;
  username?: string;
  setupRequired: boolean;
  oidcEnabled: boolean;
  oidcLabel?: string;
}

export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    loaded: false,
    authenticated: false,
    setupRequired: false,
    oidcEnabled: false,
  }),
  actions: {
    async load() {
      const s = await api<Partial<SessionState>>('/api/session').catch(() => ({}));
      this.$patch({ ...s, loaded: true });
    },
    async login(username: string, password: string) {
      await api('/auth/login', { method: 'POST', body: { username, password } });
      await this.load();
    },
    async logout() {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      this.$patch({ authenticated: false, username: undefined });
    },
  },
});

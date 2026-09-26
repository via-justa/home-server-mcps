import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { fakeApi, json, mountAt, signedIn } from './helpers';

const signedOut = {
  authenticated: false,
  setupRequired: false,
  localLoginEnabled: true,
  oidc: { enabled: false, label: 'SSO' },
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('login page', () => {
  it('redirects unauthenticated users to /login, keeping the target', async () => {
    fakeApi({ 'GET /api/session': signedOut });
    const { router, wrapper } = await mountAt('/audit');
    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.redirect).toBe('/audit');
    expect(wrapper.find('input#username').exists()).toBe(true);
    expect(wrapper.find('input#password').attributes('type')).toBe('password');
  });

  it('keeps submit disabled until both fields are filled', async () => {
    fakeApi({ 'GET /api/session': signedOut });
    const { wrapper } = await mountAt('/login');
    const button = wrapper.get('button[type="submit"]');
    expect(button.attributes('disabled')).toBeDefined();
    await wrapper.get('input#username').setValue('admin');
    await wrapper.get('input#password').setValue('hunter2');
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('posts credentials and shows an error on 401', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedOut,
      'POST /auth/login': json(401, { error: 'invalid_credentials' }),
    });
    const { wrapper } = await mountAt('/login');
    await wrapper.get('input#username').setValue('admin');
    await wrapper.get('input#password').setValue('wrong');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ username: 'admin', password: 'wrong' });
    expect(wrapper.get('[role="alert"]').text()).toBe('Invalid username or password.');
    expect((wrapper.get('input#password').element as HTMLInputElement).value).toBe('');
  });

  it('asks for the TOTP code after the password, then continues to the target', async () => {
    let session: object = signedOut;
    const { calls } = fakeApi({
      'GET /api/session': () => session,
      'POST /auth/login': { status: 'totp_required' },
      'POST /auth/totp': () => {
        session = signedIn;
        return { status: 'ok' };
      },
      'GET /api/overview': { instances: [], plugins: [], warnings: [], publicMcpUrl: null },
      'GET /api/audit': { rows: [], total: 0 },
    });
    const { wrapper, router } = await mountAt('/login?redirect=/audit');
    await wrapper.get('input#username').setValue('admin');
    await wrapper.get('input#password').setValue('correct horse battery');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('input#code').exists()).toBe(true);
    await wrapper.get('input#code').setValue('123456');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.path === '/auth/totp')?.body).toEqual({ code: '123456' });
    expect(router.currentRoute.value.path).toBe('/audit');
  });

  it('shows the SSO button with its label, and hides the password form when local login is off', async () => {
    fakeApi({
      'GET /api/session': { ...signedOut, localLoginEnabled: false, oidc: { enabled: true, label: 'Authentik' } },
    });
    const { wrapper } = await mountAt('/login?redirect=/plugins');
    const sso = wrapper.get('a.oidc');
    expect(sso.text()).toBe('Sign in with Authentik');
    expect(sso.attributes('href')).toBe('/auth/oidc/start?returnTo=%2Fplugins');
    expect(wrapper.find('input#password').exists()).toBe(false);
  });
});

describe('route guards', () => {
  it('sends everyone to /setup while no account exists', async () => {
    fakeApi({ 'GET /api/session': { ...signedOut, setupRequired: true } });
    const { router } = await mountAt('/plugins');
    expect(router.currentRoute.value.path).toBe('/setup');
  });

  it('forces TOTP enrollment when the server requires it', async () => {
    fakeApi({ 'GET /api/session': { ...signedIn, mustEnrollTotp: true } });
    const { router, wrapper } = await mountAt('/');
    expect(router.currentRoute.value.path).toBe('/enroll-totp');
    expect(wrapper.text()).toContain('Two-factor authentication is required');
  });
});

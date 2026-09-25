import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../src/App.vue';
import { createAppRouter } from '../src/router';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function mountAt(path: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return { wrapper, router };
}

describe('login page', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) =>
      url === '/api/session' ? jsonResponse(200, { authenticated: false }) : jsonResponse(401, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('redirects unauthenticated users to /login, keeping the target', async () => {
    const { router, wrapper } = await mountAt('/audit');
    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.redirect).toBe('/audit');
    expect(wrapper.find('input#username').exists()).toBe(true);
    expect(wrapper.find('input#password').attributes('type')).toBe('password');
  });

  it('keeps submit disabled until both fields are filled', async () => {
    const { wrapper } = await mountAt('/login');
    const button = wrapper.get('button[type="submit"]');
    expect(button.attributes('disabled')).toBeDefined();
    await wrapper.get('input#username').setValue('admin');
    await wrapper.get('input#password').setValue('hunter2');
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('posts credentials and shows an error on 401', async () => {
    const { wrapper } = await mountAt('/login');
    await wrapper.get('input#username').setValue('admin');
    await wrapper.get('input#password').setValue('wrong');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const call = fetchMock.mock.calls.find(([url]) => url === '/auth/login');
    expect(call?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
    expect(wrapper.get('[role="alert"]').text()).toBe('Invalid username or password.');
    expect((wrapper.get('input#password').element as HTMLInputElement).value).toBe('');
  });

  it('hides the SSO button unless OIDC is enabled', async () => {
    const { wrapper } = await mountAt('/login');
    expect(wrapper.find('a[href="/auth/oidc/start"]').exists()).toBe(false);
  });
});

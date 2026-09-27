import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SchemaForm from '../src/components/SchemaForm.vue';
import { fakeApi, json, mountAt, signedIn } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const instance = {
  id: 'i1',
  slug: 'nas',
  displayName: 'Acme',
  enabled: true,
  authMode: null,
  status: 'ready',
  statusError: null,
  upstreamVersion: '25.10.7',
  lastSyncedAt: null,
  lastSyncStatus: 'ok',
  settings: {},
  plugin: {
    id: 'p1',
    pluginId: 'acme',
    name: 'Acme',
    enabled: true,
    status: 'ok',
    labels: { operation: 'Method', operations: 'Methods' },
  },
};
const overview = { instances: [instance], plugins: [], warnings: [], publicMcpUrl: null };

const op = (key: string, extra: Record<string, unknown> = {}) => ({
  id: `op-${key}`,
  key,
  displayName: null,
  kind: 'method',
  tag: null,
  classification: 'read',
  classificationSource: 'inferred',
  inferredClassification: 'read',
  inferredReason: null,
  locked: false,
  attestationRequired: false,
  levelOverride: null,
  level: 'ask',
  writeAcknowledged: true,
  needsReview: false,
  matchProfile: null,
  group: 'app',
  reachable: true,
  mode: 'run',
  pendingReview: false,
  reason: null,
  ...extra,
});

describe('Access page', () => {
  function api(extra: Record<string, unknown> = {}) {
    return fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/groups': [
        {
          key: 'app',
          label: 'Apps',
          level: 'ask',
          stale: false,
          counts: { read: 1, write: 3, locked: 1, pendingReview: 0, overridden: 1 },
        },
        {
          key: 'store',
          label: 'Stores',
          level: 'none',
          stale: false,
          counts: { read: 1, write: 0, locked: 0, pendingReview: 0, overridden: 0 },
        },
      ],
      'GET /api/instances/i1/operations': [
        op('app.query'),
        op('app.start', { classification: 'write', mode: 'approve' }),
        op('app.stop', { classification: 'write', mode: 'approve', writeAcknowledged: false }),
        op('app.redeploy', {
          classification: 'write',
          levelOverride: 'none',
          level: 'none',
          reachable: false,
          mode: null,
          reason: 'level_none',
        }),
        op('app.delete', {
          classification: 'write',
          locked: true,
          reachable: false,
          mode: null,
          reason: 'locked_not_opted_in',
        }),
        op('store.query', { group: 'store', level: 'none', reachable: false, mode: null, reason: 'level_none' }),
      ],
      ...extra,
    });
  }

  it('offers None / Read / Ask / Write per group and sets Ask without a dialog', async () => {
    const { calls } = api({ 'PATCH /api/instances/i1/groups/store': {} });
    const { wrapper } = await mountAt('/endpoints/nas/access');
    const store = wrapper.get('[data-group="store"]');
    expect(store.findAll('[role="radio"]').map((b) => b.text())).toEqual(['None', 'Read', 'Ask', 'Write']);
    expect(wrapper.get('[data-group="app"]').text()).toContain('1 with their own level');
    await store
      .findAll('[role="radio"]')
      .find((b) => b.text() === 'Ask')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: '/api/instances/i1/groups/store',
      body: { level: 'ask' },
    });
  });

  it('lists exactly the writes that will run without asking before setting a group to Write', async () => {
    const { calls } = api({ 'PATCH /api/instances/i1/groups/app': {} });
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper
      .get('[data-group="app"]')
      .findAll('[role="radio"]')
      .find((b) => b.text() === 'Write')!
      .trigger('click');
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.text()).toContain('run without asking');
    expect(dialog.text()).toContain('app.start');
    expect(dialog.text()).toContain('app.stop');
    expect(dialog.text()).not.toContain('app.redeploy'); // has its own level
    expect(dialog.text()).not.toContain('app.delete'); // locked never auto-runs
    await dialog
      .findAll('button')
      .find((b) => b.text() === 'Set to Write')!
      .trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: '/api/instances/i1/groups/app',
      body: { level: 'write', acknowledge: ['op-app.start', 'op-app.stop'] },
    });
  });

  it('shows the server’s list when the writes changed since the page loaded', async () => {
    api({
      'PATCH /api/instances/i1/groups/app': json(409, {
        error: 'acknowledgement_mismatch',
        message: 'Acknowledge exactly the writes that will run without asking',
        details: { expected: [{ id: 'op-app.upgrade', key: 'app.upgrade' }] },
      }),
    });
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper.get('[data-group="app"]').findAll('[role="radio"]')[3]!.trigger('click');
    await wrapper
      .get('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text() === 'Set to Write')!
      .trigger('click');
    await flushPromises();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.text()).toContain('app.upgrade');
    expect(dialog.text()).toContain('The list changed');
  });

  it('bulk Write needs the slug typed and sends the previewed acknowledgement list', async () => {
    const { calls } = api({
      'GET /api/instances/i1/groups/bulk-level/preview': {
        level: 'write',
        groups: [{ key: 'app', label: 'Apps', from: 'ask', exposes: [{ id: 'op-app.start', key: 'app.start' }] }],
        acknowledge: ['op-app.start'],
      },
      'POST /api/instances/i1/groups/bulk-level': [],
    });
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'All → Write…')!
      .trigger('click');
    await flushPromises();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.text()).toContain('Ask → Write');
    const confirm = dialog.findAll('button').find((b) => b.text() === 'Set all to Write')!;
    expect(confirm.attributes('disabled')).toBeDefined();
    await dialog.get('input#bulk-confirm').setValue('nas');
    expect(confirm.attributes('disabled')).toBeUndefined();
    await confirm.trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.path === '/api/instances/i1/groups/bulk-level')?.body).toEqual({
      level: 'write',
      confirm: 'nas',
      acknowledge: ['op-app.start'],
    });
  });

  it('gives operations their own level, never Write for locked ones', async () => {
    const { calls } = api({
      'PATCH /api/instances/i1/operations/op-app.delete': {},
      'PATCH /api/instances/i1/operations/op-app.redeploy': {},
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper.get('[data-group="app"] .caret').trigger('click');

    const locked = wrapper.get('[data-op="app.delete"]');
    expect(locked.text()).toContain('Locked — not enabled');
    const lockedLevel = locked.get('select.level');
    const write = lockedLevel.findAll('option').find((o) => o.attributes('value') === 'write')!;
    expect(write.attributes('disabled')).toBeDefined();
    expect(locked.findAll('select')).toHaveLength(1); // classification of locked ops can't change
    await lockedLevel.setValue('ask');
    await flushPromises();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('fresh authenticator code'));
    expect(calls.find((c) => c.path === '/api/instances/i1/operations/op-app.delete')?.body).toEqual({ level: 'ask' });

    // "Follow group" resets an operation's own level.
    const redeploy = wrapper.get('[data-op="app.redeploy"] select.level');
    expect((redeploy.element as HTMLSelectElement).value).toBe('none');
    await redeploy.setValue('');
    await flushPromises();
    expect(calls.find((c) => c.path === '/api/instances/i1/operations/op-app.redeploy')?.body).toEqual({
      level: null,
    });
  });

  it('shows what each call does now', async () => {
    api();
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper.get('[data-group="app"] .caret').trigger('click');
    expect(wrapper.get('[data-op="app.query"]').text()).toContain('Runs');
    expect(wrapper.get('[data-op="app.start"]').text()).toContain('Asks');
    expect(wrapper.get('[data-op="app.redeploy"]').text()).toContain('Level None');
  });
});

describe('SchemaForm', () => {
  const schema = {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', title: 'URL' },
      authMethod: { type: 'string', enum: ['api_key', 'password'], default: 'api_key' },
      apiKey: { type: 'string', writeOnly: true },
      username: { type: 'string' },
      verifyTls: { type: 'boolean', default: true },
    },
    required: ['url'],
  };
  const ui = {
    apiKey: { widget: 'secret', showWhen: { field: 'authMethod', in: ['api_key'] } },
    username: { showWhen: { field: 'authMethod', in: ['password'] } },
  };

  it('shows fields per showWhen and never renders stored secrets', async () => {
    const wrapper = mount(SchemaForm, {
      props: {
        schema,
        ui,
        config: { url: 'https://nas' },
        secrets: { apiKey: { set: true, hint: '…ab12' } },
        secretPatch: {},
      },
    });
    expect(wrapper.find('[data-field="apiKey"]').exists()).toBe(true);
    expect(wrapper.find('[data-field="username"]').exists()).toBe(false);
    expect(wrapper.get('[data-field="apiKey"]').text()).toContain('Set · …ab12');
    expect(wrapper.find('[data-field="apiKey"] input').exists()).toBe(false);

    await wrapper.setProps({ config: { url: 'https://nas', authMethod: 'password' } });
    expect(wrapper.find('[data-field="apiKey"]').exists()).toBe(false);
    expect(wrapper.find('[data-field="username"]').exists()).toBe(true);
  });

  it('turns Replace / Clear into the API merge semantics', async () => {
    const wrapper = mount(SchemaForm, {
      props: {
        schema,
        ui,
        config: {},
        secrets: { apiKey: { set: true } },
        secretPatch: {},
        'onUpdate:secretPatch': (v: Record<string, string | null>) => wrapper.setProps({ secretPatch: v }),
      },
    });
    await wrapper
      .get('[data-field="apiKey"]')
      .findAll('button')
      .find((b) => b.text() === 'Clear')!
      .trigger('click');
    expect(wrapper.props('secretPatch')).toEqual({ apiKey: null });
    await wrapper
      .get('[data-field="apiKey"]')
      .findAll('button')
      .find((b) => b.text() === 'Undo')!
      .trigger('click');
    await wrapper
      .get('[data-field="apiKey"]')
      .findAll('button')
      .find((b) => b.text() === 'Replace')!
      .trigger('click');
    await wrapper.get('[data-field="apiKey"] input').setValue('new-key');
    expect(wrapper.props('secretPatch')).toEqual({ apiKey: 'new-key' });
  });
});

describe('Endpoint settings', () => {
  it('warns before letting form-only clients approve writes, and saves the opt-in', async () => {
    const settings = {
      approvalTimeoutMs: 900_000,
      formElicitationApprovals: 'off',
      executePerMinute: 30,
      writesPerMinute: 10,
      sandbox: { timeoutMs: 10_000, memoryMb: 64, maxResultBytes: 65_536 },
      extraRedactKeys: [],
      syncMaxAgeMs: 3_600_000,
      memoryMb: 256,
    };
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': { ...overview, instances: [{ ...instance, settings }] },
      'PATCH /api/instances/i1': { ...instance, settings },
    });
    const { wrapper } = await mountAt('/endpoints/nas/settings');
    expect(wrapper.text()).not.toContain('could then approve its own writes');
    const box = wrapper
      .findAll('label')
      .find((l) => l.text().includes('only show forms'))!
      .get('input');
    await box.setValue(true);
    expect(wrapper.text()).toContain('could then approve its own writes');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      settings: { formElicitationApprovals: 'writes' },
    });
  });
});

describe('Pre-approval rules', () => {
  it('builds strict rules: a named field, "any value" fields and other accepted parameters', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/rules': [],
      'GET /api/instances/i1/operations': [
        op('store.volume.create', { classification: 'write', matchProfile: 'ds', mode: 'approve' }),
      ],
      'GET /api/plugins': [
        {
          id: 'p1',
          manifest: {
            matchProfiles: {
              ds: [
                { field: '/name', label: 'Name', op: 'prefix', widget: 'text' },
                { field: '/compression', label: 'Compression', op: 'in', widget: 'multiselect' },
              ],
            },
          },
        },
      ],
      'POST /api/instances/i1/rules': {},
    });
    const { wrapper } = await mountAt('/endpoints/nas/rules');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'New rule')!
      .trigger('click');
    const dialog = wrapper.get('[role="dialog"]');
    await dialog.get('select#r-op').setValue('op-store.volume.create');
    await flushPromises();
    await wrapper.get('[role="dialog"] input[placeholder="vol/media/"]').setValue('vol/media');
    const compression = wrapper
      .get('[role="dialog"]')
      .findAll('.field')
      .find((f) => f.text().includes('Compression'))!;
    await compression.get('.any input').setValue(true);
    await wrapper.get('#r-reason').setValue('media volumes');
    await wrapper
      .get('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text() === 'Save rule')!
      .trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      match: [
        { field: '/name', op: 'prefix', value: 'vol/media' },
        { field: '/compression', op: 'any' },
      ],
    });
  });
});

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
  level: 'read',
  allowedLevels: ['none', 'read', 'ask'],
  description: null,
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

const WRITE = ['none', 'ask', 'write'];

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
        op('app.query', { description: 'Query apps.', inferredReason: 'roles:read(APPS_READ)' }),
        op('app.start', { classification: 'write', mode: 'approve', level: 'ask', allowedLevels: WRITE }),
        op('app.stop', {
          classification: 'write',
          mode: 'approve',
          level: 'ask',
          allowedLevels: WRITE,
          writeAcknowledged: false,
        }),
        op('app.redeploy', {
          classification: 'write',
          allowedLevels: WRITE,
          levelOverride: 'none',
          level: 'none',
          reachable: false,
          mode: null,
          reason: 'level_none',
        }),
        op('app.delete', {
          classification: 'write',
          locked: true,
          level: 'none',
          allowedLevels: ['none', 'ask'],
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
    // Setting the group resets operations with their own level, so app.redeploy runs too.
    expect(dialog.text()).toContain('app.redeploy');
    expect(dialog.text()).toContain('go back to following the group');
    expect(dialog.text()).not.toContain('app.delete'); // locked never auto-runs
    await dialog
      .findAll('button')
      .find((b) => b.text() === 'Set to Write')!
      .trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: '/api/instances/i1/groups/app',
      body: { level: 'write', acknowledge: ['op-app.start', 'op-app.stop', 'op-app.redeploy'] },
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
    const bulk = wrapper.get('select.bulk');
    expect(bulk.findAll('option').map((o) => o.text())).toEqual(['Set all groups…', 'None', 'Read', 'Ask', 'Write…']);
    await bulk.setValue('write');
    await flushPromises();
    // The dropdown goes back to its prompt once a choice is made.
    expect((bulk.element as HTMLSelectElement).value).toBe('');
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

  it('gives operations their own level with the same toggles, only the levels their kind allows', async () => {
    const { calls } = api({
      'PATCH /api/instances/i1/operations/op-app.delete': {},
      'PATCH /api/instances/i1/operations/op-app.redeploy': {},
      'PATCH /api/instances/i1/operations/op-app.query': {},
      'PATCH /api/instances/i1/operations/op-app.start': {},
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper.get('[data-group="app"] .caret').trigger('click');
    const radios = (key: string) => wrapper.get(`[data-op="${key}"]`).findAll('[role="radio"]');
    const patched = (key: string) => calls.filter((c) => c.path === `/api/instances/i1/operations/op-${key}`);

    // No read/write dropdown: the kind tag says where it came from.
    expect(wrapper.find('[data-op="app.query"] select').exists()).toBe(false);
    expect(wrapper.get('[data-op="app.query"] .kind').attributes('title')).toBe('Requires APPS_READ');
    expect(wrapper.get('[data-op="app.query"]').text()).toContain('Query apps.');

    expect(radios('app.query').map((b) => b.text())).toEqual(['None', 'Read', 'Ask']);
    expect(radios('app.start').map((b) => b.text())).toEqual(['None', 'Ask', 'Write']);
    expect(
      radios('app.query')
        .find((b) => b.attributes('aria-checked') === 'true')
        ?.text(),
    ).toBe('Read');

    // A locked op shows Write disabled, and asks before opening at Ask.
    const locked = wrapper.get('[data-op="app.delete"]');
    expect(locked.text()).toContain('Locked — not enabled');
    const write = radios('app.delete').find((b) => b.text().startsWith('Write'))!;
    expect(write.attributes('disabled')).toBeDefined();
    await radios('app.delete')
      .find((b) => b.text() === 'Ask')!
      .trigger('click');
    await flushPromises();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('fresh authenticator code'));
    expect(patched('app.delete')[0]?.body).toEqual({ level: 'ask' });

    // A read at its own Ask.
    await radios('app.query')
      .find((b) => b.text() === 'Ask')!
      .trigger('click');
    await flushPromises();
    expect(patched('app.query')[0]?.body).toEqual({ level: 'ask' });

    // Picking what the group already gives (Ask) just clears an own level.
    await radios('app.redeploy')
      .find((b) => b.text() === 'Ask')!
      .trigger('click');
    await flushPromises();
    expect(patched('app.redeploy')[0]?.body).toEqual({ level: null });

    // ↺ only on operations with their own level, to the right of the toggle.
    expect(wrapper.find('[data-op="app.start"] .reset').exists()).toBe(false);
    const reset = wrapper.get('[data-op="app.redeploy"] .reset');
    expect(reset.element.previousElementSibling?.classList.contains('segmented')).toBe(true);
    await reset.trigger('click');
    await flushPromises();
    expect(patched('app.redeploy')[1]?.body).toEqual({ level: null });
    expect(wrapper.get('[data-op="app.redeploy"]').text()).not.toContain('own level');

    // Write on a plain write warns first.
    await radios('app.start')
      .find((b) => b.text() === 'Write')!
      .trigger('click');
    await flushPromises();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('without asking anyone'));
    expect(patched('app.start')[0]?.body).toEqual({ level: 'write' });
  });

  it('shows what each call does now', async () => {
    api();
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper.get('[data-group="app"] .caret').trigger('click');
    expect(wrapper.get('[data-op="app.query"]').text()).toContain('Runs');
    expect(wrapper.get('[data-op="app.start"]').text()).toContain('Asks');
    expect(wrapper.get('[data-op="app.redeploy"]').text()).toContain('Off');
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
  it('builds $targets selectors from what the plugin declares', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': overview,
      'GET /api/instances/i1/rules': [],
      'GET /api/instances/i1/operations': [
        op('widget.set', { classification: 'write', matchProfile: 'w', mode: 'approve' }),
      ],
      'GET /api/instances/i1/registry': (_body: unknown, url: URL) =>
        url.searchParams.get('kind') === 'zone'
          ? [{ kind: 'zone', id: 'zone_a', name: 'Zone A', parentId: null, scopes: null }]
          : [{ kind: 'item', id: 'widget.one', name: 'Widget One', parentId: null, scopes: { type: 'widget' } }],
      'GET /api/plugins': [
        {
          id: 'p1',
          manifest: {
            targets: {
              label: 'Widget',
              registryKind: 'item',
              scopes: [
                { key: 'zone', label: 'Zone', registryKind: 'zone' },
                { key: 'type', label: 'Type' },
              ],
            },
            matchProfiles: {
              w: [
                {
                  field: '$targets',
                  label: 'Targets',
                  widget: 'registry-picker',
                  options: { scopes: ['zone'], filter: { type: 'widget' } },
                },
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
    await wrapper.get('[role="dialog"] select#r-op').setValue('op-widget.set');
    await flushPromises();
    const picker = wrapper.get('[role="dialog"] .picker');
    // Only the scopes this field offers; the target field is named as the plugin names its targets.
    expect(picker.findAll('label').map((l) => l.text())).toEqual(['Zone', 'Widget']);
    // Scope values come from their registry kind; target suggestions are narrowed by the field's filter.
    const registryCalls = calls.filter((c) => c.path.startsWith('/api/instances/i1/registry')).map((c) => c.path);
    expect(registryCalls).toContain('/api/instances/i1/registry?kind=zone&limit=500');
    expect(registryCalls.some((p) => p.includes('kind=item') && p.includes('scope.type=widget'))).toBe(true);

    const zone = picker.findAll('.field').find((f) => f.text().includes('Zone'))!;
    await zone.get('input').setValue('zone_a');
    await zone.get('input').trigger('keydown', { key: 'Enter' });
    await wrapper.get('#r-reason').setValue('zone A widgets');
    await wrapper
      .get('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text() === 'Save rule')!
      .trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      match: [{ field: '$targets', scopes: { zone: ['zone_a'] } }],
    });
  });

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

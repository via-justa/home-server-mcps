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
  displayName: 'TrueNAS',
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
    pluginId: 'truenas',
    name: 'TrueNAS',
    enabled: true,
    status: 'ok',
    labels: { operation: 'Method', operations: 'Methods' },
  },
};
const overview = { instances: [instance], plugins: [], pendingApprovals: 0, warnings: [], publicMcpUrl: null };

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
  excluded: false,
  lockedOptIn: false,
  writeAcknowledged: false,
  needsReview: false,
  matchProfile: null,
  group: 'app',
  reachable: true,
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
          level: 'read',
          stale: false,
          counts: { read: 1, write: 2, locked: 1, pendingReview: 2 },
        },
        {
          key: 'pool',
          label: 'Pools',
          level: 'none',
          stale: false,
          counts: { read: 1, write: 0, locked: 0, pendingReview: 0 },
        },
      ],
      'GET /api/instances/i1/operations': [
        op('app.query'),
        op('app.start', { classification: 'write', reachable: false, reason: 'group_read_only' }),
        op('app.stop', { classification: 'write', reachable: false, reason: 'group_read_only' }),
        op('app.delete', { classification: 'write', locked: true, reachable: false, reason: 'group_read_only' }),
        op('pool.query', { group: 'pool', reachable: false, reason: 'group_none' }),
      ],
      ...extra,
    });
  }

  it('raising a group to Write lists exactly the writes it exposes and acknowledges them', async () => {
    const { calls } = api({ 'PATCH /api/instances/i1/groups/app': {} });
    const { wrapper } = await mountAt('/endpoints/nas/access');
    expect(wrapper.text()).toContain('2 new write operations wait for review');

    const app = wrapper.get('[data-group="app"]');
    await app
      .findAll('[role="radio"]')
      .find((b) => b.text() === 'Write')!
      .trigger('click');
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.text()).toContain('app.start');
    expect(dialog.text()).toContain('app.stop');
    expect(dialog.text()).not.toContain('app.delete');
    expect(dialog.text()).toContain('1 locked operation(s) stay off');

    await dialog
      .findAll('button')
      .find((b) => b.text() === 'Allow writes')!
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
        message: 'Acknowledge exactly the writes this change exposes',
        details: { expected: [{ id: 'op-app.upgrade', key: 'app.upgrade' }] },
      }),
    });
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper.get('[data-group="app"]').findAll('[role="radio"]')[2]!.trigger('click');
    await wrapper
      .get('[role="dialog"]')
      .findAll('button')
      .find((b) => b.text() === 'Allow writes')!
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
        groups: [{ key: 'app', label: 'Apps', from: 'read', exposes: [{ id: 'op-app.start', key: 'app.start' }] }],
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

  it('offers "Allow…" for locked operations only when the group is at Write', async () => {
    api();
    const { wrapper } = await mountAt('/endpoints/nas/access');
    await wrapper.get('[data-group="app"] .caret').trigger('click');
    const row = wrapper.get('[data-op="app.delete"]');
    expect(row.text()).toContain('locked');
    expect(row.findAll('button').some((b) => b.text() === 'Allow…')).toBe(false);
    expect(row.find('select').exists()).toBe(false); // classification of locked ops can't change
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

describe('Pending approvals', () => {
  it('keeps Approve disabled until the typed confirmation matches', async () => {
    const { calls } = fakeApi({
      'GET /api/session': signedIn,
      'GET /api/overview': { ...overview, pendingApprovals: 1 },
      'GET /api/approvals': [
        {
          id: 'a1',
          instanceId: 'i1',
          operationId: 'op',
          paramsDisplay: { name: 'tank/x', password: '[REDACTED]' },
          resolvedTargets: null,
          summary: 'Delete dataset tank/x',
          confirmLiteral: 'tank/x',
          diff: null,
          clientKind: 'mcp_client',
          clientId: 'claude',
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          status: 'pending',
          decidedBy: null,
          decidedVia: null,
          decidedAt: null,
          requiresConfirmation: true,
          operation: { key: 'pool.dataset.delete', classification: 'locked' },
          instance: { id: 'i1', slug: 'nas', displayName: 'TrueNAS' },
        },
      ],
      'POST /api/approvals/a1/approve': { outcome: 'approved' },
    });
    const { wrapper } = await mountAt('/approvals');
    const card = wrapper.get('[data-approval="a1"]');
    expect(card.text()).toContain('Delete dataset tank/x');
    const approve = card.findAll('button').find((b) => b.text() === 'Approve')!;
    expect(approve.attributes('disabled')).toBeDefined();
    await card.get('input.confirm').setValue('tank/x');
    expect(approve.attributes('disabled')).toBeUndefined();
    await card.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.path === '/api/approvals/a1/approve')?.body).toEqual({ confirm: 'tank/x' });
  });
});

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { exportAuditCsv, queryAudit } from '../../audit-query.js';
import { toPublicUser } from '../../auth/users.js';
import { operations, pendingApprovals, pluginInstances, plugins } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { CORE_EVENT_NAMES } from '../../events.js';
import { getSettings, isSettingsSection, updateSettings } from '../../settings.js';
import { readJson } from '../common.js';
import type { AdminEnv } from './auth.js';

/** Global Admin API routes (design §8.4): overview, plugins, approvals, audit, tokens, users, settings, events. */
export function registerSystemRoutes(app: Hono<AdminEnv>, ctx: AppContext) {
  const actor = (c: { get: (k: 'user') => { id: string } }) => ({ userId: c.get('user').id });

  const mcpBase = () => ctx.config.PUBLIC_MCP_URL?.replace(/\/$/, '') ?? '';

  app.get('/api/overview', (c) => {
    const mcpSettings = getSettings(ctx.db, 'mcp');
    const pendingBy = new Map(
      ctx.db
        .select({ instanceId: pendingApprovals.instanceId, n: count() })
        .from(pendingApprovals)
        .where(eq(pendingApprovals.status, 'pending'))
        .groupBy(pendingApprovals.instanceId)
        .all()
        .map((r) => [r.instanceId, r.n]),
    );
    const instances = ctx.instances.list().map((i) => ({
      ...i,
      endpointUrl: `${mcpBase()}/${i.slug}`,
      effectiveAuthMode: i.authMode ?? mcpSettings.defaultAuthMode,
      pendingApprovals: pendingBy.get(i.id) ?? 0,
    }));
    return c.json({
      instances,
      plugins: ctx.db
        .select()
        .from(plugins)
        .orderBy(asc(plugins.pluginId))
        .all()
        .map((p) => ({
          id: p.id,
          pluginId: p.pluginId,
          status: p.status,
          enabled: p.enabled,
        })),
      pendingApprovals: [...pendingBy.values()].reduce((a, b) => a + b, 0),
      warnings: ctx.warnings,
      publicMcpUrl: ctx.config.PUBLIC_MCP_URL ?? null,
    });
  });

  // ── plugins ──

  app.get('/api/plugins', (c) => {
    const counts = new Map(
      ctx.db
        .select({ pluginId: pluginInstances.pluginId, n: count() })
        .from(pluginInstances)
        .groupBy(pluginInstances.pluginId)
        .all()
        .map((r) => [r.pluginId, r.n]),
    );
    return c.json(
      ctx.db
        .select()
        .from(plugins)
        .orderBy(asc(plugins.pluginId))
        .all()
        .map((p) => ({ ...p, instances: counts.get(p.id) ?? 0 })),
    );
  });

  app.patch('/api/plugins/:id', async (c) => {
    const { enabled } = await readJson(c, z.object({ enabled: z.boolean() }));
    await ctx.instances.setPluginEnabled(c.req.param('id'), enabled, actor(c));
    return c.json(
      ctx.db
        .select()
        .from(plugins)
        .where(eq(plugins.id, c.req.param('id')))
        .get() ?? null,
    );
  });

  app.post('/api/plugins/rescan', (c) => c.json(ctx.discoverPlugins()));

  // ── approvals (design §5.3) ──

  app.get('/api/approvals', (c) => {
    const status = c.req.query('status') ?? 'pending';
    const instance = c.req.query('instance');
    const conditions = [];
    if (status !== 'all') conditions.push(eq(pendingApprovals.status, status as 'pending'));
    if (instance) conditions.push(eq(pendingApprovals.instanceId, instance));
    const rows = ctx.db
      .select({ approval: pendingApprovals, op: operations, instance: pluginInstances })
      .from(pendingApprovals)
      .innerJoin(operations, eq(pendingApprovals.operationId, operations.id))
      .innerJoin(pluginInstances, eq(pendingApprovals.instanceId, pluginInstances.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(pendingApprovals.requestedAt))
      .limit(Math.min(Number(c.req.query('limit')) || 100, 500))
      .all();
    return c.json(
      rows.map(({ approval, op, instance: inst }) => {
        const { paramsHash: _hash, ...rest } = approval;
        return {
          ...rest,
          // Shown to the approver, who must type it back (TN §3.4) — the point is a deliberate act, not secrecy.
          requiresConfirmation: !!approval.confirmLiteral,
          operation: { key: op.key, classification: op.locked ? 'locked' : op.classification },
          instance: { id: inst.id, slug: inst.slug, displayName: inst.displayName },
        };
      }),
    );
  });

  const Decision = z.object({ confirm: z.string().optional() });
  app.post('/api/approvals/:id/approve', async (c) => {
    const { confirm } = await readJson(c, Decision);
    return c.json(
      ctx.approvals.decide(c.req.param('id'), {
        approve: true,
        confirm,
        decidedBy: c.get('user').username,
        via: 'portal',
      }),
    );
  });
  app.post('/api/approvals/:id/deny', (c) =>
    c.json(
      ctx.approvals.decide(c.req.param('id'), { approve: false, decidedBy: c.get('user').username, via: 'portal' }),
    ),
  );

  // ── audit ──

  app.get('/api/audit', (c) => c.json(queryAudit(ctx.db, c.req.query())));
  app.get('/api/audit/export.csv', (c) => {
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(exportAuditCsv(ctx.db, c.req.query()));
  });

  // ── MCP bearer tokens (design §6.2) ──

  app.get('/api/tokens', (c) => c.json(ctx.tokens.list()));
  app.post('/api/tokens', async (c) => c.json(ctx.tokens.create(await readJson(c, z.unknown()), actor(c)), 201));
  app.delete('/api/tokens/:id', (c) => {
    ctx.tokens.revoke(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  // ── OAuth clients & grants (design §6.2) ──

  app.get('/api/oauth/clients', (c) => c.json(ctx.oauth.listClients()));
  app.post('/api/oauth/clients', async (c) => {
    const body = await readJson(
      c,
      z.object({
        name: z.string().trim().min(1).max(100),
        redirectUris: z.array(z.string()).min(1).max(10),
        confidential: z.boolean().default(false),
      }),
    );
    return c.json(
      ctx.oauth.register(
        {
          client_name: body.name,
          redirect_uris: body.redirectUris,
          token_endpoint_auth_method: body.confidential ? 'client_secret_post' : 'none',
        },
        'admin',
        actor(c),
      ),
      201,
    );
  });
  app.delete('/api/oauth/clients/:id', (c) => {
    ctx.oauth.revokeClient(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });
  app.get('/api/oauth/grants', (c) => c.json(ctx.oauth.listGrants()));
  app.delete('/api/oauth/grants/:id', (c) => {
    ctx.oauth.revokeGrant(c.req.param('id'), actor(c));
    return c.body(null, 204);
  });

  // ── users (no roles: every user is an admin) ──

  app.get('/api/users', (c) => c.json(ctx.users.list()));
  app.post('/api/users', async (c) => {
    const body = await readJson(c, z.object({ username: z.string(), password: z.string().optional() }));
    return c.json(await ctx.users.create(body, actor(c)), 201);
  });
  app.patch('/api/users/:id', async (c) => {
    const body = await readJson(c, z.object({ disabled: z.boolean().optional(), password: z.string().optional() }));
    const id = c.req.param('id');
    if (body.disabled !== undefined) {
      if (id === c.get('user').id && body.disabled)
        throw new ConflictError('self_disable', 'You cannot disable yourself');
      ctx.users.setDisabled(id, body.disabled, actor(c));
      if (body.disabled) ctx.sessions.revokeUser(id);
    }
    if (body.password !== undefined) {
      await ctx.users.setPassword(id, body.password, { actorId: c.get('user').id });
      ctx.sessions.revokeUser(id);
    }
    return c.json(toPublicUser(ctx.users.get(id)));
  });
  app.post('/api/users/:id/reset-totp', (c) => {
    ctx.users.resetTotp(c.req.param('id'), actor(c));
    return c.json(toPublicUser(ctx.users.get(c.req.param('id'))));
  });

  // ── settings ──

  app.get('/api/settings', (c) =>
    c.json({
      security: getSettings(ctx.db, 'security'),
      mcp: getSettings(ctx.db, 'mcp'),
      audit: getSettings(ctx.db, 'audit'),
      oidc: ctx.oidc.getSettings(),
      forceLocalLogin: ctx.config.ADMIN_FORCE_LOCAL_LOGIN,
      publicMcpUrl: ctx.config.PUBLIC_MCP_URL ?? null,
      publicAdminUrl: ctx.config.PUBLIC_ADMIN_URL ?? null,
    }),
  );

  app.put('/api/settings/oidc', async (c) => {
    const body = await readJson(c, z.record(z.string(), z.unknown()));
    return c.json(ctx.oidc.updateSettings(body, actor(c)));
  });

  app.put('/api/settings/:section', async (c) => {
    const section = c.req.param('section');
    if (!isSettingsSection(section)) throw new NotFoundError('unknown_section', 'Unknown settings section');
    const body = await readJson(c, z.record(z.string(), z.unknown()));
    // Disabling local login locks everyone out unless SSO works and someone can use it (design §6.1).
    if (section === 'security' && body.disableLocalLogin === true) {
      if (!ctx.oidc.isEnabled() || !ctx.users.hasOidcLinkedUser()) {
        throw new ValidationError(
          'oidc_required',
          'Enable OIDC and link at least one user before disabling local login',
        );
      }
    }
    return c.json(updateSettings(ctx.db, section, body, actor(c)));
  });

  // ── live events for the portal (approvals, instance status, sync) ──

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const handlers = CORE_EVENT_NAMES.map((name) => {
        const handler = (payload: unknown) => void stream.writeSSE({ event: name, data: JSON.stringify(payload) });
        ctx.events.on(name, handler as never);
        return [name, handler] as const;
      });
      const heartbeat = setInterval(() => void stream.writeSSE({ event: 'ping', data: '{}' }), 25_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(heartbeat);
      for (const [name, handler] of handlers) ctx.events.off(name, handler as never);
    }),
  );
}

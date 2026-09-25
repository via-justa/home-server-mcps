import type { Context, Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../../app.js';
import { operations, pendingApprovals, pluginInstances } from '../../db/schema.js';
import { ServiceError } from '../../errors.js';
import { clientIp } from '../common.js';
import { checkUiCsrf, renderLogin, uiCsrf, uiSession } from './oauth-routes.js';
import { approvalPage, errorPage } from './pages.js';

/**
 * Approval-link pages (design §9.2). A link from a notification only opens this page: deciding still
 * needs a signed-in portal user and a CSRF-protected POST, so a leaked or prefetched link decides nothing.
 */
export function registerApprovalRoutes(app: Hono, ctx: AppContext) {
  const gone = (c: Context) =>
    errorPage(
      c,
      'Link expired',
      'This approval link has expired or was already used. Open the admin portal to review approvals.',
      404,
    );

  const load = (c: Context, token: string) => {
    const link = ctx.links.resolve(token);
    if (!link) {
      // Tokens are unguessable; this only slows down noisy scanners.
      ctx.throttle.allowIp(clientIp(c, ctx.config.TRUST_PROXY));
      return null;
    }
    const row = ctx.db
      .select({ approval: pendingApprovals, op: operations, instance: pluginInstances })
      .from(pendingApprovals)
      .innerJoin(operations, eq(pendingApprovals.operationId, operations.id))
      .innerJoin(pluginInstances, eq(pendingApprovals.instanceId, pluginInstances.id))
      .where(eq(pendingApprovals.id, link.approvalId))
      .get();
    return row ? { link, ...row } : null;
  };

  const render = (
    c: Context,
    token: string,
    data: NonNullable<ReturnType<typeof load>>,
    username: string,
    error?: string,
  ) =>
    approvalPage(
      c,
      {
        token,
        csrf: uiCsrf(ctx, c),
        username,
        slug: data.instance.slug,
        instanceName: data.instance.displayName,
        operationKey: data.op.key,
        locked: data.op.locked,
        summary: data.approval.summary,
        params: data.approval.paramsDisplay,
        targets: data.approval.resolvedTargets,
        diff: data.approval.diff,
        expiresAt: data.approval.expiresAt,
        confirmLiteral: data.approval.confirmLiteral,
        intent: data.link.action,
        status: data.approval.status,
        error,
      },
      error ? 400 : 200,
    );

  app.get('/a/:token', (c) => {
    const token = c.req.param('token');
    const data = load(c, token);
    if (!data) return gone(c);
    const session = uiSession(ctx, c);
    if (!session) return renderLogin(ctx, c, `/a/${token}`, 'Sign in to review this approval request.');
    return render(c, token, data, session.user.username);
  });

  app.post('/a/:token', async (c) => {
    const token = c.req.param('token');
    const body = await c.req.parseBody();
    const data = load(c, token);
    if (!data) return gone(c);
    const session = uiSession(ctx, c);
    if (!session) return renderLogin(ctx, c, `/a/${token}`, 'Your sign-in expired. Sign in again to decide.');
    if (!checkUiCsrf(c, body.csrf))
      return render(c, token, data, session.user.username, 'The form expired; try again.');
    const approve = body.decision === 'approve';
    if (!approve && body.decision !== 'deny')
      return render(c, token, data, session.user.username, 'Choose approve or deny.');
    try {
      ctx.approvals.decide(data.approval.id, {
        approve,
        confirm: typeof body.confirm === 'string' ? body.confirm : undefined,
        decidedBy: session.user.username,
        via: 'link',
      });
    } catch (err) {
      if (err instanceof ServiceError) return render(c, token, data, session.user.username, err.message);
      throw err;
    }
    ctx.links.consumeAll(data.approval.id);
    return errorPage(
      c,
      approve ? 'Approved' : 'Denied',
      `${data.op.key} on /${data.instance.slug} was ${approve ? 'approved' : 'denied'}.`,
      200,
    );
  });
}

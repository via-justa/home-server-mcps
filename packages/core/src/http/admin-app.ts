import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { AppContext } from '../app.js';
import { csrfGuard, registerAuthRoutes, registerProfileRoutes, requireUser } from './admin/auth.js';
import type { AdminEnv } from './admin/auth.js';
import { registerInstanceRoutes } from './admin/instances.js';
import { registerSystemRoutes } from './admin/system.js';
import { errorResponse } from './common.js';

export interface AdminAppOptions {
  /** Built admin-ui assets. The SPA is optional so the API can run without a UI build (tests, dev). */
  uiDir?: string;
}

/** Paths the SPA fallback must never swallow, so API/auth typos surface as 404s. */
const NON_SPA_PREFIXES = ['/api', '/auth', '/.well-known', '/healthz'];

/** The LAN-only admin listener (design §2.1): Vue SPA + Admin API + login/OIDC. */
export function createAdminApp(ctx: AppContext, { uiDir }: AdminAppOptions = {}): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.onError(errorResponse);

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.use('/api/*', csrfGuard(ctx));
  app.use('/auth/*', csrfGuard(ctx));
  registerAuthRoutes(app, ctx); // public: session probe, setup, login, OIDC

  // Everything else under /api needs a signed-in user.
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/session' || c.req.path === '/api/setup') return next();
    return requireUser(ctx)(c, next);
  });
  registerProfileRoutes(app, ctx);
  registerInstanceRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  app.all('/api/*', (c) => c.json({ error: 'not_found', message: 'No such API route' }, 404));

  const indexHtml = uiDir ? path.join(uiDir, 'index.html') : undefined;
  if (uiDir && indexHtml && existsSync(indexHtml)) {
    const html = readFileSync(indexHtml, 'utf8');
    app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), uiDir) }));
    app.get('*', (c, next) => {
      if (NON_SPA_PREFIXES.some((p) => c.req.path === p || c.req.path.startsWith(`${p}/`))) return next();
      return c.html(html);
    });
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

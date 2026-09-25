import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

export interface AdminAppDeps {
  /** Built admin-ui assets. The SPA is optional so the API can run without a UI build (tests, dev). */
  uiDir?: string;
}

/** Paths the SPA fallback must never swallow, so API/auth typos surface as 404s. */
const NON_SPA_PREFIXES = ['/api', '/auth', '/.well-known', '/healthz'];

/** The LAN-only admin listener (design §2.1): Vue SPA + Admin API + login/OIDC. */
export function createAdminApp({ uiDir }: AdminAppDeps = {}): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Admin API and auth are implemented in phases 10 and 12 (design §13). Until then the SPA sees
  // an unauthenticated session and routes to the login page.
  app.get('/api/session', (c) => c.json({ authenticated: false }));
  app.all('/api/*', (c) => c.json({ error: 'not_implemented' }, 501));
  app.all('/auth/*', (c) => c.json({ error: 'not_implemented' }, 501));

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

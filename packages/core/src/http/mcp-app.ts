import { Hono } from 'hono';
import type { AppContext } from '../app.js';
import { errorResponse } from './common.js';
import { McpEndpoints } from './mcp/endpoint.js';
import { registerOAuthRoutes } from './mcp/oauth-routes.js';

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id: null,
  error: { code, message },
});

/**
 * The public MCP listener (design §2.1): `/{slug}` endpoints, OAuth metadata/flows and approval-link
 * pages. Nothing from the Admin API is mounted here.
 */
export function createMcpApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.onError(errorResponse);
  const endpoints = new McpEndpoints(ctx, ctx.oauth);
  ctx.onStop(() => endpoints.closeAll());

  // Aggregate status only; per-instance detail lives on the admin port (design §11).
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  registerOAuthRoutes(app, ctx, ctx.oauth);
  app.all('/.well-known/*', (c) => c.json({ error: 'not_found' }, 404));
  app.all('/oauth/*', (c) => c.json({ error: 'not_found' }, 404));

  app.all('/:slug', (c) => endpoints.handle(c, c.req.param('slug')));

  app.notFound((c) => c.json(jsonRpcError(-32001, 'Not found'), 404));
  return app;
}

import { Hono } from 'hono';
import type { EndpointRegistry } from '../endpoints/registry.js';

export interface McpAppDeps {
  endpoints: EndpointRegistry;
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: null, error: { code, message } };
}

/**
 * The public MCP listener (design §2.1): `/{slug}` endpoints, OAuth metadata/flows and approval-link
 * pages. Nothing from the Admin API is mounted here.
 */
export function createMcpApp({ endpoints }: McpAppDeps): Hono {
  const app = new Hono();

  // Aggregate status only; per-instance detail lives on the admin port (design §11).
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Placeholders for design §6.2 — implemented in the MCP-auth phase.
  app.all('/.well-known/*', (c) => c.json({ error: 'not_implemented' }, 501));
  app.all('/oauth/*', (c) => c.json({ error: 'not_implemented' }, 501));
  app.all('/a/:token', (c) => c.json({ error: 'not_implemented' }, 501));

  app.all('/:slug', (c) => {
    const endpoint = endpoints.get(c.req.param('slug'));
    if (!endpoint) return c.json(jsonRpcError(-32001, 'Unknown MCP endpoint'), 404);
    if (!endpoint.enabled) return c.json(jsonRpcError(-32002, 'MCP endpoint is disabled'), 503);
    // Streamable HTTP transport per instance is wired in the MCP-endpoints phase (design §13, phase 14).
    return c.json(jsonRpcError(-32603, 'MCP endpoint not implemented yet'), 501);
  });

  app.notFound((c) => c.json(jsonRpcError(-32001, 'Not found'), 404));
  return app;
}

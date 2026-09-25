import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { Config } from './config/env.js';
import { EndpointRegistry } from './endpoints/registry.js';
import { createAdminApp } from './http/admin-app.js';
import { createMcpApp } from './http/mcp-app.js';

export interface RunningServers {
  mcp: { server: Server; port: number };
  admin: { server: Server; port: number };
  close(): Promise<void>;
}

function listen(app: { fetch: (req: Request) => Response | Promise<Response> }, hostname: string, port: number) {
  return new Promise<{ server: Server; port: number }>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname, port }, (info: AddressInfo) =>
      resolve({ server: server as Server, port: info.port }),
    ) as Server;
    server.once('error', reject);
  });
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

/** Starts the two listeners on separate ports (design §2.1). */
export async function startServers(config: Config): Promise<RunningServers> {
  const endpoints = new EndpointRegistry();
  const mcp = await listen(createMcpApp({ endpoints }), config.MCP_HOST, config.MCP_PORT);
  const admin = await listen(createAdminApp({ uiDir: config.ADMIN_UI_DIR }), config.ADMIN_HOST, config.ADMIN_PORT);
  return {
    mcp,
    admin,
    close: async () => {
      await Promise.all([close(mcp.server), close(admin.server)]);
    },
  };
}

import { createAppContext } from './app.js';
import { loadConfig } from './config/env.js';
import { startServers } from './server.js';

const config = loadConfig();
const ctx = await createAppContext(config);
for (const warning of ctx.warnings) console.warn(`WARN ${warning}`);
if (ctx.users.count() === 0) console.log('No users yet: open the admin portal to create the first account.');
await ctx.start();

const servers = await startServers(ctx);
console.log(`MCP listener on ${config.MCP_HOST}:${servers.mcp.port}`);
console.log(`Admin listener on ${config.ADMIN_HOST}:${servers.admin.port}`);

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  // Drain first (approvals, MCP sessions, SSE), then close the listeners with a grace period, then stop
  // plugins and the database; nothing here waits on a client that keeps its connection open.
  ctx
    .drain()
    .then(() => servers.close())
    .then(() => ctx.stop())
    .then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

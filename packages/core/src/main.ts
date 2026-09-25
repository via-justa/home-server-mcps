import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config/env.js';
import { startServers } from './server.js';

const config = loadConfig();
const core = bootstrap(config);
for (const warning of core.warnings) console.warn(`WARN ${warning}`);
console.log(
  `Plugins: ${[...core.plugins.added, ...core.plugins.updated].join(', ') || 'none'} (data in ${config.DATA_DIR})`,
);

const servers = await startServers(config);

console.log(`MCP listener on ${config.MCP_HOST}:${servers.mcp.port}`);
console.log(`Admin listener on ${config.ADMIN_HOST}:${servers.admin.port}`);

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down`);
  servers.close().then(
    () => {
      core.db.$client.close();
      process.exit(0);
    },
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

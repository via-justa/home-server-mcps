import { loadConfig } from './config/env.js';
import { startServers } from './server.js';

const config = loadConfig();
const servers = await startServers(config);

console.log(`MCP listener on ${config.MCP_HOST}:${servers.mcp.port}`);
console.log(`Admin listener on ${config.ADMIN_HOST}:${servers.admin.port}`);

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down`);
  servers.close().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

import { ErrorCodes, PluginError, runPlugin } from '@home-server-mcps/plugin-sdk';

// Skeleton only: behavior follows docs/reference/seerr-mcp-design.md §2.2–§2.3 (seerr-api.yml fetch, verb default, GET-as-action flag),
// mapped onto the plugin hooks in docs/design/unified-mcp-server.md §3.4.
const notImplemented = (method: string) => (): never => {
  throw new PluginError(ErrorCodes.NotImplemented, `Seerr plugin: ${method} is not implemented yet`);
};

runPlugin({
  init: notImplemented('init'),
  testConnection: notImplemented('testConnection'),
  getUpstreamVersion: notImplemented('getUpstreamVersion'),
  syncCatalog: notImplemented('syncCatalog'),
  resolveOperation: notImplemented('resolveOperation'),
  summarize: notImplemented('summarize'),
  invoke: notImplemented('invoke'),
});

import { ErrorCodes, PluginError, runPlugin } from '@synoikia/plugin-sdk';

// Skeleton only: behavior follows docs/reference/truenas-mcp-design.md §2.2–§2.3 (core.get_methods sync, naming inference, locked seeds),
// mapped onto the plugin hooks in docs/design/unified-mcp-server.md §3.4.
const notImplemented = (method: string) => (): never => {
  throw new PluginError(ErrorCodes.NotImplemented, `TrueNAS plugin: ${method} is not implemented yet`);
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

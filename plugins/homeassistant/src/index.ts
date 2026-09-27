import { ErrorCodes, PluginError, runPlugin } from '@synoikia/plugin-sdk';

// Skeleton only: behavior follows docs/reference/homeassistant-mcp-design.md §2.2–§2.4, §2.8, §3.6 (services + WS commands, registry, transforms, attestation),
// mapped onto the plugin hooks in docs/design/unified-mcp-server.md §3.4.
const notImplemented = (method: string) => (): never => {
  throw new PluginError(ErrorCodes.NotImplemented, `Home Assistant plugin: ${method} is not implemented yet`);
};

runPlugin({
  init: notImplemented('init'),
  testConnection: notImplemented('testConnection'),
  getUpstreamVersion: notImplemented('getUpstreamVersion'),
  syncCatalog: notImplemented('syncCatalog'),
  resolveOperation: notImplemented('resolveOperation'),
  summarize: notImplemented('summarize'),
  invoke: notImplemented('invoke'),
  syncRegistry: notImplemented('syncRegistry'),
  resolveTargets: notImplemented('resolveTargets'),
  prepareWrite: notImplemented('prepareWrite'),
  getGuide: notImplemented('getGuide'),
});

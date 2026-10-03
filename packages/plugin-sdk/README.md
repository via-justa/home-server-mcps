# @synoikia/plugin-sdk

The plugin side of [Synoikia](https://github.com/via-justa/synoikia-core): the manifest schema, the core ⇄ plugin RPC contract and `runPlugin()`, plus the building blocks a plugin is made of. Everything here is bundled into each plugin, so it runs inside the plugin's permission-confined child, never in core. Guide: [`docs/plugin-authoring.md`](https://github.com/via-justa/synoikia-core/blob/main/docs/plugin-authoring.md).

| Module                                                  | What                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `manifest`, `rpc`, `operations`, `run-plugin`, `errors` | The contract core validates every plugin against                                      |
| `plugin-kit`                                            | `definePlugin` lifecycle, `lazy` caches, small guards                                 |
| `rules`                                                 | `plugin.yaml`: `PluginSettingsSchema`, `parsePluginSettings`, `compileRules`          |
| `http-client`, `url`, `upstream-errors`                 | `HttpJsonClient`, base URLs, upstream error mapping                                   |
| `pending`                                               | `PendingRequests`, `singleFlight` for socket protocols                                |
| `openapi`, `static-catalog`                             | Catalogs from an OpenAPI spec or from `plugin.yaml` `operations:`, and their bindings |
| `conformance`                                           | `checkConformance`, `checkManifest`                                                   |

`plugin-settings.schema.json` (JSON Schema of `plugin.yaml`, for editors) ships next to `dist/`.

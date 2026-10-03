---
name: add-plugin
description: Scaffold a new Synoikia plugin under plugins/<id> with `pnpm new`, then fill in its plugin.yaml rules, discovery and tests. Use when asked to add, create or start a plugin for a new upstream service.
---

# Add a plugin

## 1. Settle the basics

- **`<id>`**: lowercase, the directory name and manifest `id`; the sandbox namespace defaults to it in camelCase.
- **Archetype**: `openapi-rest` (the upstream serves an OpenAPI spec), `static-rest` (a REST API without one; operations are declared in `plugin.yaml`), `websocket-rpc` (JSON-RPC over WebSocket), or `blank`.
- **Auth**: `bearer`, `api-key` (with its header), `basic` or `none`.
- **Destructive operations**: which ones are `locked` (always a human who types a confirmation literal), and what that literal is.
- **Secrets**: which connection fields are credentials, and which fields the upstream returns hold secrets.

## 2. Scaffold

```sh
pnpm new --id <id> --name "<Name>" --archetype <archetype> --auth <auth> --yes
```

This writes `plugins/<id>/` (manifest, `plugin.yaml`, `src/`, a fake upstream, unit and e2e tests) and runs `pnpm install`. The generated plugin already builds and passes its tests.

## 3. Describe the upstream

- `manifest.json`: connection fields and help, `sensitiveKeys` (add every secret field the upstream returns), `network.hosts`.
- `plugin.yaml`: `rules` for locks, splits, classification overrides, `sensitiveParams`, `sensitiveResult`, `confirm` literals and summary notes; `exclude` for plumbing the model has no business calling. A rule's `classification` can never unlock a locked operation, and anything unclassified is a write.
- `src/plugin.ts`: only what needs logic, such as a `splitWhen` predicate or a custom confirm source.

## 4. Tests

Extend `test/fake-upstream.ts` to answer what the plugin calls, including responses with secrets. Keep `checkPluginContract` in `test/e2e.test.ts` passing, and add unit tests for every rule that locks or masks something.

```sh
pnpm --filter ./plugins/<id> test
pnpm typecheck && pnpm lint && pnpm format:check
```

Then run the `security-reviewer` subagent on the diff.

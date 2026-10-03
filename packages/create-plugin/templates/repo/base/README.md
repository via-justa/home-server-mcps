# {{repoName}}

Plugins for [Synoikia](https://github.com/via-justa/synoikia-core), the self-hosted MCP control plane.

A plugin only describes its upstream API: the operations it has, which ones read and which ones write, which are destructive, and which fields hold secrets. Synoikia's core decides what is allowed and runs every call through its sandbox, permission gate, approvals, redaction and audit log. See the [plugin authoring guide](https://github.com/via-justa/synoikia-core/blob/main/docs/plugin-authoring.md).

## Layout

| Path                         | What                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `plugins/<id>/manifest.json` | Binding, connection form, `sensitiveKeys`, network hosts                                 |
| `plugins/<id>/plugin.yaml`   | What the plugin tells core about its operations: locks, splits, secrets, confirm literals |
| `plugins/<id>/src/`          | Discovery, auth and anything that needs logic                                            |
| `plugins/<id>/test/`         | A fake upstream, unit tests and e2e tests on Synoikia's harness                          |

## Development

Requires Node ≥ 22.12 and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm new          # add a plugin
pnpm test         # check, build and test every plugin
pnpm typecheck && pnpm lint && pnpm format:check
```

Work on one plugin with `pnpm --filter ./plugins/<id> test`.

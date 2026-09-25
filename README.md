# home-server-mcps

One self-hosted MCP server for a home lab, extended by plugins. It has a single admin portal. Each plugin instance gets its own MCP endpoint:

```
https://mcp.example.com/truenas   → TrueNAS plugin
https://mcp.example.com/seerr     → Seerr plugin
https://mcp.example.com/ha        → Home Assistant plugin
http://admin.lan:8081             → Admin portal (separate port, login required)
```

Each endpoint exposes two MCP tools, `search(code)` and `execute(code)`. Model-authored code runs inside an `isolated-vm` sandbox, and every upstream call passes through a permission gate:

- Reads run immediately.
- Writes need a human approval, given through MCP elicitation, the portal, or an ntfy/webhook link. The exception is a write that matches a narrow pre-approval rule.
- Destructive operations are `locked`: they need typed confirmation and can never be pre-approved.

**Design:** [`docs/design/unified-mcp-server.md`](docs/design/unified-mcp-server.md). The original per-server designs and UI mockups it builds on are in [`docs/reference/`](docs/reference/).

> **Status:** core foundations (design §13, phases 0–4): database + encryption, catalog sync with group-level access, and the sandboxed plugin host. Not yet: sandbox, approval gate, auth, Admin API, MCP endpoints, real plugin logic. See the progress table in design §13.

## Layout

| Path                  | What                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/plugin-sdk` | Plugin manifest schema, core ⇄ plugin RPC contract, `runPlugin()` child runtime                                          |
| `packages/core`       | Core process: MCP listener (:8080), admin listener (:8081), DB schema, and later the plugin host, gate, sandbox and auth |
| `packages/admin-ui`   | Vue 3 admin portal (served by core on :8081)                                                                             |
| `plugins/*`           | Core plugins: `truenas`, `seerr`, `homeassistant`                                                                        |

## Development

Requires Node ≥ 22.12 and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm test        # all packages (workspace deps resolve to TS sources, no build needed)
pnpm typecheck
pnpm lint
pnpm build
DATA_DIR=./data pnpm start   # MCP on :8080, admin on :8081; creates ./data/hsm.sqlite + master.key
```

Admin UI with hot reload: run `pnpm start` in one shell and `pnpm --filter @home-server-mcps/admin-ui dev` in another. Vite proxies `/api` and `/auth` to `:8081`.

DB schema changes: edit `packages/core/src/db/schema.ts`, then `pnpm --filter @home-server-mcps/core db:generate`.

## Deployment

```sh
cp .env.example .env   # set MASTER_KEY, PUBLIC_MCP_URL, …
docker compose -f docker-compose.example.yml up -d --build
```

Put `:8080` behind your reverse proxy as the public MCP hostname. Keep `:8081` reachable from the LAN or VPN only. See design §11.

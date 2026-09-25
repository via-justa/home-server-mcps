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

> **Status:** the core is complete (design §13, phases 0–16): encryption, catalog sync with group-level access, the permission-confined plugin host, the `isolated-vm` sandbox, the permission gate with pre-approval rules and human approval, admin auth (local + TOTP + OIDC), MCP auth (external, bearer, OAuth 2.1), the Admin API and portal, ntfy/webhook notifications with approval links, plugin repositories with minisign signing, and maintenance jobs. Not yet: the TrueNAS, Seerr and Home Assistant plugin logic (phases 17–19). See the progress table in design §13.

## Layout

| Path                  | What                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/plugin-sdk` | Plugin manifest schema, core ⇄ plugin RPC contract, `runPlugin()` child runtime                                        |
| `packages/core`       | Core process: MCP listener (:8080), admin listener (:8081), plugin host, sandbox, permission gate, auth, notifications |
| `packages/admin-ui`   | Vue 3 admin portal (served by core on :8081)                                                                           |
| `plugins/*`           | Core plugins: `truenas`, `seerr`, `homeassistant`                                                                      |

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

Put `:8080` behind your reverse proxy as the public MCP hostname and set `PUBLIC_MCP_URL` to it. Keep `:8081` reachable from the LAN or VPN only. See design §11.

On first start, open the admin portal and create the first account (or set `ADMIN_BOOTSTRAP_USERNAME`/`ADMIN_BOOTSTRAP_PASSWORD` once). Then enable plugins, create an endpoint, raise the access groups you want above Read, and connect your MCP client to `PUBLIC_MCP_URL/<slug>`.

### Rotating the master key

Stop the server, then:

```sh
docker compose -f docker-compose.example.yml stop
# key file in the data volume: a new key is generated and written for you
docker compose -f docker-compose.example.yml run --rm home-server-mcps node packages/core/dist/cli.js rotate-master-key
# MASTER_KEY from the environment: create the replacement first and keep it — it is the only copy
NEW_KEY="$(openssl rand -base64 32)"; echo "$NEW_KEY"
docker compose -f docker-compose.example.yml run --rm -e NEW_MASTER_KEY="$NEW_KEY" home-server-mcps node packages/core/dist/cli.js rotate-master-key
# then set MASTER_KEY=$NEW_KEY in .env and start the server again
```

Every session is signed out afterwards.

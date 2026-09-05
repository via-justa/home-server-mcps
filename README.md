# home-server-mcps

A FastMCP (Python) server that lets Claude operate a home media stack — Sonarr,
Radarr, Lidarr, Prowlarr, and Seerr (Overseerr/Jellyseerr) — through 8 tools,
deployed as a remote streamable-HTTP MCP server.

## Tools

| Tool | Services | Purpose |
|---|---|---|
| `get_services` | all | List configured instances, optionally with quality profiles/root folders/tags |
| `search` | seerr, lidarr, prowlarr | Search movies/TV, artists, or indexer releases |
| `get_media` | seerr, sonarr, radarr, lidarr | Fetch details for one media item |
| `request_media` | seerr, lidarr | Request/add movies, TV, or an artist |
| `manage_requests` | seerr | Get/list/approve/decline/delete requests, or counts |
| `manage_queue` | sonarr, radarr, lidarr | View/remove the download queue, trigger commands |
| `manage_library` | sonarr, radarr, lidarr | List/get/delete already-added library items |
| `manage_config` | prowlarr | List/test indexers, list applications, trigger a sync |

`shelfmark` and `profilarr` are **not wired up yet** — see "Known gaps" below.
Calling any tool with `service="shelfmark"` or `service="profilarr"` (or an
unconfigured service) returns a clear error rather than failing silently.

## Setup

Requires [uv](https://docs.astral.sh/uv/).

```bash
uv sync
cp .env.example .env   # fill in the services you have
```

Each service needs a base URL + API key, via env vars (see `.env.example`):

```
SONARR_URL=http://sonarr.local:8989
SONARR_API_KEY=...
```

For multiple instances of one service (e.g. a separate 4K Radarr), use
`RADARR_INSTANCES` as a JSON array instead — see `.env.example` for the shape.

**YAML config (lower priority than env vars):** any service with no
`{SERVICE}_URL`/`{SERVICE}_API_KEY`/`{SERVICE}_INSTANCES` env vars set falls
back to a YAML file — `./config.yaml` by default, or the path in
`MEDIA_APPS_MCP_CONFIG`. See `config.example.yaml` for the shape. Precedence
is per-service: one service can come from env vars while another comes from
the YAML file.

## Running

```bash
uv run media-apps-mcp
```

Starts the streamable-HTTP MCP server on `MCP_HOST`:`MCP_PORT` (default
`0.0.0.0:8000`), serving at `/mcp`.

**Connecting:**
- **Claude Code:** `claude mcp add --transport http media-apps http://<host>:8000/mcp`
- **Claude Desktop / claude.ai:** Settings → Connectors → Add custom connector.
  This requires **HTTPS** — put a TLS-terminating reverse proxy or tunnel
  (Tailscale Funnel, Cloudflare Tunnel) in front if you want this path; a plain
  LAN `http://` URL only works from Claude Code.

## Development

```bash
uv run pytest
```

Tests use `respx` to mock the upstream HTTP APIs — no live services needed.
`tests/test_server.py` exercises the real FastMCP tool registration/dispatch
in-process via `fastmcp.Client`.

## Known gaps

- **Profilarr**: its public REST API [hasn't shipped yet](https://github.com/Dictionarry-Hub/profilarr/issues/401)
  (tracked for a future 2.x release). `manage_config(service="profilarr", ...)`
  returns a clear "not yet supported" error until it does.
- **shelfmark**: its REST API exists but is undocumented publicly. Wiring it up
  needs live endpoint discovery against a real instance (check for a
  Swagger/OpenAPI doc, or capture requests from its web UI's network tab)
  rather than third-party docs. `search`/`request_media`/`manage_requests`
  with `service="shelfmark"` return a clear "not yet supported" error.
- The HTTP transport binding itself (`mcp.run(transport="http", ...)`) is
  stock FastMCP/uvicorn and hasn't been booted end-to-end in this dev
  environment (its sandbox blocks opening listening sockets); verify it opens
  and responds to `initialize`/`tools/list` once deployed.

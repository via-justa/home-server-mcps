# Gaps and follow-up plan

Tracks what's intentionally unfinished in this server, why, and what a future
session needs to know to pick each item up. Update this file as gaps are
closed or new ones are found — don't let it go stale.

## Blocked on external factors

### 1. Profilarr isn't wired up — its public API hasn't shipped

`manage_config(service="profilarr", ...)` raises `NotYetSupportedError`
(see [tools/config_sync.py](src/media_apps_mcp/tools/config_sync.py)).
Profilarr's REST API is tracked in
[Dictionarry-Hub/profilarr#401](https://github.com/Dictionarry-Hub/profilarr/issues/401),
targeted for a future 2.x release, not yet released as of 2026-09-05.

**Planned shape once it ships** (from that issue): `GET /arr/{id}/quality-profiles`,
`GET /arr/{id}/custom-formats`, `GET`/`PUT /arr/{id}/sync/quality-profiles`,
`POST /arr/{id}/sync/quality-profiles/run`. Auth mechanism was explicitly
deferred in the issue ("API key lifecycle stays web-only") — check what
shipped, it may not be a simple static API key like the other services.

**To pick this up:** check whether a 2.x release has shipped and whether it
exposes the endpoints above. If so, add `clients/profilarr.py` (model it on
`clients/prowlarr.py` — same "list what's available, sync to app" shape),
add a `profilarr` case to `tools/config_sync.py` alongside the existing
Prowlarr logic, and add `ServiceRegistry.profilarr()`. Confirm the actual
auth mechanism against a real instance rather than assuming an API key
header — TDD it with `respx` the same way every other client here was built.

### 2. shelfmark isn't wired up — its API is undocumented

`search`/`request_media`/`manage_requests` with `service="shelfmark"` raise
`NotYetSupportedError`. shelfmark (calibrain/shelfmark) has a real REST API +
WebSocket server (Flask + Flask-SocketIO per its DeepWiki page), but no
publicly documented endpoints, request/response shapes, or auth mechanism
were findable as of 2026-09-05 — only that `/api/health` exists
unauthenticated and that auth is configurable (none/builtin/proxy/OIDC/CWA).

**To pick this up:** this needs a real running shelfmark instance to inspect,
not more web research — the docs genuinely don't exist yet. Options, in order
of preference:
1. Check for a live Swagger/OpenAPI doc on the instance itself (common paths:
   `/api/docs`, `/apidocs`, `/swagger.json`, `/openapi.json`).
2. Open the shelfmark web UI, watch its network tab while searching/
   requesting a book, and reverse-engineer the request/response shapes from
   that (its frontend API layer is `src/frontend/src/services/api.ts` in the
   shelfmark repo, if source access is easier than a running instance).
3. Once the shapes are known: add `clients/shelfmark.py` following the
   `ApiClient` pattern in `clients/base.py` (adjust `api_key_header` if
   shelfmark doesn't use `X-Api-Key`), then wire the three `shelfmark`
   branches in `tools/search.py`, `tools/requests.py` (both functions), each
   currently a single `raise NotYetSupportedError(...)` line to replace.

## Deferred by design (in scope, cut for v1 to keep the tool count minimal)

### 3. Lidarr search/request is artist-only, not album-level

`search(service="lidarr", ...)` calls `ServarrClient.lookup()`, which is
pinned to the `artist` resource (`GET /api/v1/artist/lookup`) — there's no
album-level search (`GET /api/v1/album/lookup`). The typical Lidarr workflow
(add the artist, then monitor specific albums) makes this a reasonable v1
scope, not a bug, but it means "find just this one album" isn't directly
supported.

**To pick this up:** add a `lookup_album(term)` method to
`ServarrClient` (or a `resource` override param on the existing `lookup()`),
and a `sub_resource` param on the `search` tool to select artist vs. album
for `service="lidarr"`. TDD it the same way `test_client_servarr.py`
tests `lookup()` today.

### 4. No dedupe/batch-availability-check in `search`

The MCP that inspired this design (visible as a connected connector during
planning) had a `dedupeMode` that batch-checks many titles against
availability/existing-request status in one call, plus `autoRequest`. Both
were cut here to keep `search`'s scope tractable for v1 — it does single-query
search with `format` trimming and nothing else.

**To pick this up:** only worth doing if batch title-checking turns out to be
a real workflow need. Would live as new parameters on
[tools/search.py](src/media_apps_mcp/tools/search.py)'s `search()`, calling
`get_media`/`manage_library` internally per candidate title.

### 5. `request_media`'s Seerr server/profile pairing isn't auto-resolved

`SeerrClient.radarr_server()`/`sonarr_server()` (Seerr's own view of which
Radarr/Sonarr instance + quality profile + root folder pairing is
configured) are implemented and tested in
[clients/seerr.py](src/media_apps_mcp/clients/seerr.py), but nothing in the
tool layer calls them yet. Today, `request_media(service="seerr", ...)`
requires the caller to already know valid `server_id`/`profile_id`/
`root_folder` values, or to omit them and rely on Seerr's own defaults.

**To pick this up:** consider exposing these via
`get_services(service="seerr", detail=True)` — right now `detail=True` only
fetches profiles/folders/tags for direct arr-family instances (see
`SERVARR_KINDS` in [tools/services.py](src/media_apps_mcp/tools/services.py));
add a Seerr branch that calls `radarr_servers()`/`sonarr_servers()` and, for
each, `radarr_server(id)`/`sonarr_server(id)` for the profile/folder options.

## Known limitations (not necessarily gaps — worth knowing before relying on this)

### 6. The HTTP transport binding has never been booted end-to-end

`server.py`'s `mcp.run(transport="http", ...)` is stock FastMCP/uvicorn, but
the dev sandbox used to build this blocks opening listening sockets, so it's
only been verified via `fastmcp.Client(mcp)` in-process (real tool dispatch,
no real socket). **Before trusting a deploy:** run `uv run media-apps-mcp`
somewhere that allows listening sockets and hit it with `curl` or the MCP
Inspector (`npx @modelcontextprotocol/inspector --cli http://host:8000/mcp
--transport http --method tools/list`).

### 7. The server has no auth of its own

Any client that can reach the HTTP port can call all 8 tools, including
destructive ones (`manage_library` delete, `manage_requests` delete,
`manage_queue` remove). Fine on a fully trusted LAN; **do not** put this
behind a public tunnel (Tailscale Funnel, Cloudflare Tunnel — needed anyway
for the Claude Desktop/claude.ai connector path, see README) without adding
an auth layer in front of it first (FastMCP supports an `auth` provider on
`FastMCP(...)`, or terminate auth at the reverse proxy).

### 8. Multi-instance selection isn't exposed above the registry layer

`ServiceRegistry.instance(service, instance_id)` supports picking a
non-default instance (tested in `test_registry.py`), but none of the 8 tools
currently accept an `instance_id` parameter — they always resolve to
whichever instance is marked `is_default`. Only matters if you actually
configure multiple instances of one service (e.g. `RADARR_INSTANCES` with
both an HD and 4K server) and want to target the non-default one directly.

**To pick this up:** thread an optional `instance_id: str | None = None`
through the relevant tool functions and their `registry.servarr(...)` /
`registry.prowlarr(...)` / `registry.seerr(...)` calls.

### 9. No retry/backoff on upstream API calls

`ApiClient` (in `clients/base.py`) raises `ApiError` immediately on any
non-2xx response — no retry for transient 5xx or 429 (rate-limited)
responses. Prowlarr indexer search and Seerr are the most likely to
rate-limit under heavy use.

### 10. Read/write actions share tools, which blocks Anthropic Directory submission

Several tools (`manage_requests`, `manage_queue`, `manage_library`,
`manage_config`) mix read actions (list/get) and write actions
(approve/delete/remove/sync) behind one `action` enum. This was a deliberate
tradeoff for tool-count minimalism (an explicit ask for this project) and is
fine for personal/team use, but the Anthropic Directory's review criteria
require read and write operations in separate tools — splitting them would
be needed before any directory submission.

### 11. No CI

No GitHub Actions (or other CI) workflow runs `uv run pytest` on push/PR.
Straightforward to add; just hasn't been done.

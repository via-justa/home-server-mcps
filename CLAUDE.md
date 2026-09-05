# CLAUDE.md

Guidance for Claude Code sessions working in this repo.

## What this is

A FastMCP (Python) server exposing a home media stack — Sonarr, Radarr,
Lidarr, Prowlarr, Seerr (Overseerr/Jellyseerr) — as **8 tools**, deployed as a
remote streamable-HTTP MCP server. See [README.md](README.md) for the tool
list and setup, and [GAPS.md](GAPS.md) for what's intentionally unfinished
and why.

The overriding design constraint is **token efficiency with a minimal tool
set**: 8 tools cover 5 services by grouping on function (search, get details,
request, manage queue/library/config) rather than one tool per service per
verb, and every response supports a `format`/`level` of `compact` (default),
`standard`, or `full` to avoid paying for fields nobody asked for.

## Architecture

```
config.py       — ServiceInstance model + load_service_instances() (env vars, then YAML)
registry.py     — ServiceRegistry: resolves a service+instance to a client, caches instance lists
clients/        — one class per upstream API family (base.py is the shared HTTP/error-mapping layer)
  base.py         ApiClient: injects the API key header, maps non-2xx to ApiError with a hint
  servarr.py      ServarrClient: shared by Sonarr/Radarr/Lidarr (same API shape, different resource name/version)
  prowlarr.py     ProwlarrClient
  seerr.py        SeerrClient
formatting.py   — project_fields/project_many: the compact/standard/full field-trimming helpers
errors.py       — NotYetSupportedError, raised by shelfmark/profilarr code paths
tools/          — one module per tool, pure business logic taking `registry` as its first arg
server.py       — FastMCP app; each @mcp.tool is a thin wrapper forwarding to tools/*
```

**Why business logic lives in `tools/*.py` instead of directly in
`@mcp.tool` functions in `server.py`:** it lets tests call the logic with a
lightweight fake registry/client (plain classes with the methods used, no
mocking framework) instead of spinning up FastMCP or real HTTP. `server.py`
should stay a thin dispatch layer — if you're adding real logic there instead
of in a `tools/` module, stop and move it.

## Conventions to follow

- **TDD, strictly.** Every function in this repo was written test-first — see
  git history for the pattern (write the test, watch it fail for the right
  reason, then write minimal code to pass). Continue that discipline: don't
  add a function without a failing test driving it first.
- **Test layering:** `clients/*` tests use `respx` to mock real HTTP calls
  (verifies URL construction, headers, query params, error mapping).
  `tools/*` tests use hand-written fake client/registry classes (verifies
  business logic — field trimming, validation, batching — without redoing
  HTTP-mocking for logic that doesn't touch HTTP directly). `test_server.py`
  uses `fastmcp.Client(mcp)` in-process to verify tool registration,
  annotations, and end-to-end dispatch. Match new tests to the layer they
  belong to.
- **Adding a new arr-family action:** put it on `ServarrClient` (works for
  Sonarr/Radarr/Lidarr automatically) unless the semantics genuinely differ
  per app.
- **Adding a field to a response:** it belongs in a `_COMPACT_FIELDS` or
  `_STANDARD_FIELDS` list (see any `tools/*.py`), not hardcoded into the
  return dict — `format="full"` already passes the raw upstream response
  through unchanged.
- **A service/action Claude shouldn't call yet:** raise
  `NotYetSupportedError(service, reason)` from `errors.py`, not a bare
  exception — it's what shelfmark and profilarr do today.
- **Dependency management:** `uv`, not pip/poetry. `uv add <pkg>` for a new
  runtime dependency, `uv add --dev <pkg>` for test-only. `UV_CACHE_DIR` may
  need to be set to a writable path (e.g. `$TMPDIR/uv-cache`) in sandboxed
  environments where `~/.cache/uv` isn't writable.

## Running things

```bash
uv run pytest                 # full test suite, no live services needed
uv run pytest tests/test_x.py -q
uv run media-apps-mcp         # start the real HTTP server (needs a real .env)
```

`server.py`'s `mcp.run(transport="http", ...)` binding is stock
FastMCP/uvicorn — it has never been booted end-to-end in a dev sandbox here
(sandboxes that block opening listening sockets can't test it), so a real
`curl`/MCP Inspector check against a deployed instance is still worthwhile
after non-trivial `server.py` changes.

## Before extending Profilarr or shelfmark support

Read [GAPS.md](GAPS.md) first — both need live endpoint discovery against a
real running instance (not third-party docs, which are stale or don't
exist), and GAPS.md records what's already known.

# Unified Pluggable MCP Server — Design Document

> Status: **Draft v1** · Supersedes the per-server deployment model of the three source designs in
> [`docs/reference/`](../reference/) while keeping their permission model intact.

Source documents referenced throughout:

| Short name | File                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TN**     | [`truenas-mcp-design.md`](../reference/truenas-mcp-design.md)                                                                                                    |
| **SR**     | [`seerr-mcp-design.md`](../reference/seerr-mcp-design.md)                                                                                                        |
| **HA**     | [`homeassistant-mcp-design.md`](../reference/homeassistant-mcp-design.md)                                                                                        |
| Mockups    | [`mockups/admin-portal/`](../reference/mockups/admin-portal/), [`mockups/ha-pre-approval-match-selector/`](../reference/mockups/ha-pre-approval-match-selector/) |

A reference like **TN §3.4** means section 3.4 of the TrueNAS design.

---

## 1. Purpose & Scope

The three source designs describe three servers that share one architecture: search/execute "Code Mode" tools, an `isolated-vm` sandbox, a call-time permission gate, and a SQLite-backed Vue Admin Portal. Built as written, you get three processes, three portals, three databases, three login surfaces, and three copies of the same security-critical gate.

This design merges them into **one server process with one Admin Portal and a plugin system**:

- Each integration (TrueNAS, Seerr, Home Assistant, and future ones) is a **plugin**.
- A plugin can run as one or more **instances**. Each instance has its own upstream connection, operation catalog, rules, and audit trail.
- Each instance is exposed as a **dedicated MCP endpoint** at an admin-chosen path slug: `https://mcp.example.com/truenas`, `/seerr`, `/ha`, `/ha-cabin`.
- The **Admin Portal runs on a separate port** from the MCP endpoints. It has a real login page (local accounts, optional OIDC, optional TOTP).
- The permission gate, sandbox, approvals, pre-approval rules, audit log, auth, and notifications are implemented **once, in core**. Plugins only provide the upstream-specific parts: catalog discovery, classification seeds, target resolution, and the actual upstream call.

### 1.1 What carries over unchanged from the source docs

These decisions are not reopened. Each is now implemented once in core and applies to every plugin:

- **Two MCP tools per endpoint:** `search(code)` and `execute(code)` (TN §2.1).
- **Fail-closed classification.** Precedence is `locked` > `override` > inferred/default. Ambiguous cases default to `write` (TN §2.3).
- **Reachability is a separate gate from classification**, and every endpoint starts read-only (TN §2.3, TN §10). What changes is _how_ it is controlled: an access level per group instead of a toggle per operation (§1.2, §5.2.1).
- **Call-time interception.** The bound function is the sandbox's only egress and the only enforcement point (TN §3.2).
- **Approvals.** Elicitation is the primary path. The portal Pending Approvals page is always available. Unanswered approvals are auto-denied after 15 min. Approvals are single-use and scoped to the exact params (and resolved targets) (TN §3.3, HA §3.3).
- **Typed confirmation** for `locked` operations (TN §3.4).
- **Pre-approval rules.** Picked from the synced catalog, never free text. Rules have structured `match`, a rate limit that falls back to a human, expiry, and a required reason. Rules can **never** reference a `locked` operation; the API returns 409 (TN §3.5).
- **API-enforced locks.** Classification changes on `locked` rows are rejected with 409 at the API, not only hidden in the UI (TN §2.6).
- **Redaction** on reads and writes, in model output, logs, and the portal (TN §4).
- **Append-only audit log**, including configuration changes (TN §6).
- **Maintenance cadence.** Session-start debounced sync, version-triggered sync, daily cron backstop, and mid-session recheck (TN §5).
- **Upstream credentials.** Encrypted at rest, write-only through the API, and never inside the sandbox (TN §4).
- **Per-plugin rules stay as specified**, now owned by each plugin: HA's no `ws_command` escape hatch, surgical config edits with optimistic locking, best-practice attestation, and area/entity/domain match pickers (HA §2.2, §2.8, §3.6, §2.4). Seerr's GET-as-action detection (SR §2.3) and on-behalf-of approval policy (SR §3.4).
- **TDD phase discipline** (TN §7).

### 1.2 What changes, and why

| Source-doc decision                                                          | Unified decision                                                                                                                                                                                                                                     | Why                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FastMCP per server (TN §2.5)                                                 | **Official `@modelcontextprotocol/sdk`**, one Streamable HTTP transport per endpoint path, all on one **Hono** listener                                                                                                                              | FastMCP assumes one server per HTTP listener. We need N endpoints on one port. FastMCP is a thin wrapper over the SDK, so no capability is lost: elicitation is `server.elicitInput()`, and sessions come from the transport's session IDs. |
| One SQLite DB per server                                                     | **One SQLite DB** with instance-scoped tables                                                                                                                                                                                                        | One portal and one audit log. Cross-instance views (a global Pending Approvals inbox) are simple queries.                                                                                                                                   |
| Basic-auth via env vars (TN §10)                                             | **Login page**: local users (argon2id) in the DB, optional TOTP, optional OIDC                                                                                                                                                                       | Requested explicitly. Basic-auth has no logout, no 2FA, and no SSO.                                                                                                                                                                         |
| Portal on the same process/port or "as a module in the Vue frontend" (TN §8) | **Admin listener on its own port (8081)**, MCP listener on 8080                                                                                                                                                                                      | Requested explicitly. The public reverse proxy only ever forwards 8080, so the admin surface is not internet-reachable by construction.                                                                                                     |
| MCP transport auth = "bearer token if exposed" (TN §4)                       | **Four auth modes**, a global default plus a per-endpoint override: `external`, `bearer`, `oauth`, `bearer+oauth` (§6.2)                                                                                                                             | Remote clients such as claude.ai custom connectors need OAuth. CLI and automation clients want static tokens. Homelabs often already run Cloudflare Access or Authelia.                                                                     |
| Notification channel deferred (TN §10)                                       | **ntfy + generic webhook in v1**, with signed approve/deny links (§9)                                                                                                                                                                                | With several endpoints in one server, headless approvals come up often enough to justify it. The approval mechanism was already written to accept this as an addition.                                                                      |
| Per-operation Enabled toggle (TN §2.3, SR §2.3, HA §2.3)                     | **Per-group access level** — `none` / `read` / `write` — over plugin-derived groups (TrueNAS namespace, Seerr tag, HA domain), with exclude-only per-op overrides, per-op opt-in for locked ops, and quarantine for newly discovered writes (§5.2.1) | Hundreds to 1,000+ rows per instance made per-op toggles unmanageable. One control per resource ("TrueNAS apps: read") works the same for every plugin and keeps auto-discovery.                                                            |
| One hard-coded integration per server                                        | **Dynamic plugins**: core plugins in this repo plus third-party plugins from HACS-style index repos (§4)                                                                                                                                             | Requested explicitly.                                                                                                                                                                                                                       |

### 1.3 Non-goals (v1)

- No RBAC. All portal users are full admins, which keeps the single-operator posture of TN §2.6. The user table exists so that OIDC, TOTP, and per-user audit attribution work.
- No horizontal scaling. One core process owns the SQLite file. The TN §5 advisory-lock note still applies inside the process, per instance.
- No built-in TLS. TLS is terminated by the reverse proxy (Traefik, Caddy, or a Cloudflare Tunnel).
- No aggregated "all tools" endpoint. Each instance is its own MCP server by design.

---

## 2. Topology

```
                       Internet / LAN                                   LAN only
                  mcp.example.com (TLS @ proxy)                admin.lan (TLS @ proxy, optional)
                              │                                            │
┌─────────────────────────────┼────────────────────────────────────────────┼──────────────┐
│ Container                   ▼                                            ▼              │
│  ┌──────────────────────────────────────────────┐   ┌─────────────────────────────────┐ │
│  │ MCP listener :8080  (Hono)                   │   │ Admin listener :8081  (Hono)    │ │
│  │  /{slug}            Streamable HTTP MCP      │   │  /            Vue SPA           │ │
│  │  /.well-known/oauth-*                        │   │  /api/*       Admin REST API    │ │
│  │  /oauth/authorize|token|register|consent     │   │  /auth/*      login, OIDC cb    │ │
│  │  /a/{token}         approval-link page       │   │  /healthz                       │ │
│  │  /healthz                                    │   └───────────────┬─────────────────┘ │
│  └──────────────┬───────────────────────────────┘                   │                   │
│                 │ endpoint auth (§6.2)                               │ session auth (§6.1)│
│                 ▼                                                    ▼                   │
│  ┌───────────────────────────────── core process ───────────────────────────────────┐   │
│  │  Endpoint registry ── MCP Server per instance (search, execute)                  │   │
│  │        │                                                                         │   │
│  │        ▼                                                                         │   │
│  │  Sandbox runner (isolated-vm) ── binding ──▶ Permission gate (§5)                │   │
│  │                                               │  attest → enable → targets →     │   │
│  │                                               │  classify → pre-approve → human  │   │
│  │                                               ▼                                  │   │
│  │  Approval service ◀──▶ elicitation / portal inbox / notifiers (§9)               │   │
│  │  Plugin host (§4) ── IPC JSON-RPC ──┬──────────────┬──────────────┐              │   │
│  │  Scheduler (§10)   SQLite + crypto  │              │              │              │   │
│  └─────────────────────────────────────┼──────────────┼──────────────┼──────────────┘   │
│                                        ▼              ▼              ▼                  │
│                                  ┌──────────┐   ┌──────────┐   ┌──────────┐             │
│                                  │ truenas  │   │ seerr    │   │ ha       │  child      │
│                                  │ instance │   │ instance │   │ instance │  processes  │
│                                  └────┬─────┘   └────┬─────┘   └────┬─────┘             │
└───────────────────────────────────────┼──────────────┼──────────────┼───────────────────┘
                                        ▼              ▼              ▼
                                     TrueNAS         Seerr     Home Assistant
```

### 2.1 Listener separation

The two listeners are two separate Hono apps bound to two ports. **A route that belongs to one listener does not exist on the other.** For example, `GET :8080/api/instances` and `GET :8081/truenas` both return 404, and tests assert this (§13).

| Listener | Default        | Env                        | Serves                                                                                                          |
| -------- | -------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| MCP      | `0.0.0.0:8080` | `MCP_HOST`, `MCP_PORT`     | MCP endpoints, OAuth AS + protected-resource metadata, OAuth login/consent page, approval-link page, `/healthz` |
| Admin    | `0.0.0.0:8081` | `ADMIN_HOST`, `ADMIN_PORT` | SPA, Admin API, admin login and OIDC callback, `/healthz`                                                       |

`PUBLIC_MCP_URL` (for example `https://mcp.example.com`) is required whenever any endpoint uses OAuth or notifications are enabled. It is the issuer and resource base in OAuth metadata and the base for approval links. `PUBLIC_ADMIN_URL` is optional; it is used for OIDC redirect URIs and deep links in notifications.

The MCP port serves a **small, fixed set of HTML pages**: OAuth login, OAuth consent, and approval-link login/decision. These pages reuse the same user accounts and OIDC configuration as the admin portal. They issue a **separate cookie**: a different name, `Path=/oauth` or `/a`, and a short lifetime. That cookie is not accepted by the Admin API. Holding it grants only "complete this OAuth consent" or "decide this one approval".

### 2.2 Endpoint routing

- `/{slug}` is the Streamable HTTP endpoint for the instance with that slug. `POST` carries JSON-RPC, `GET` carries the SSE stream, and `DELETE` ends the session. These are the SDK's `StreamableHTTPServerTransport` semantics.
- Slugs match `^[a-z0-9][a-z0-9-]{0,62}$`, are unique, and cannot use reserved words: `oauth`, `a`, `healthz`, `.well-known`, `api`, `auth`, `static`.
- A disabled instance, or an instance whose plugin is disabled, returns **503** with a JSON-RPC error body. A slug that doesn't exist returns **404**.
- Each instance has its own `McpServer` object exposing `search` and `execute`. Their tool descriptions are templated from the plugin manifest (binding name, a short upstream description) so the model sees `truenas.call(...)` on `/truenas` and `ha.call(...)` on `/ha`.
- MCP sessions are keyed by `(instance, Mcp-Session-Id)`. The session records the authenticated client identity (§6.2) and whether the client advertised the elicitation capability.

---

## 3. Plugin Model

### 3.1 Responsibilities split

| Concern                                                                 | Core                            | Plugin                                                                   |
| ----------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| MCP protocol, sessions, tool schemas                                    | ✅                              |                                                                          |
| Endpoint and admin authentication                                       | ✅                              |                                                                          |
| Sandbox (`isolated-vm`) and binding injection                           | ✅                              | declares binding names                                                   |
| Group access levels, classification precedence, locked enforcement      | ✅                              | supplies **group**, **inferred classification** and **locked seed list** |
| Pre-approval rule storage and evaluation                                | ✅ generic evaluator            | declares **matchable fields** per operation                              |
| Approval flow, typed confirmation, timeouts                             | ✅                              | supplies human **summary** and the **confirmation literal**              |
| Audit log, redaction engine                                             | ✅                              | declares **sensitive keys**                                              |
| DB, encryption, master key                                              | ✅                              | never sees the DB or the master key                                      |
| Upstream connection and credential use                                  |                                 | ✅ receives only its own decrypted secrets                               |
| Catalog discovery (`core.get_methods`, `seerr-api.yml`, `get_services`) |                                 | ✅                                                                       |
| Registry mirror (HA entities, areas, devices)                           | stores                          | ✅ produces                                                              |
| Target resolution (area → entities)                                     | calls                           | ✅                                                                       |
| Config-transform / optimistic locking (HA §2.8)                         | shows the diff, stores the hash | ✅ computes                                                              |
| Best-practice guides and attestation keys (HA §3.6)                     | issues and validates keys       | ✅ supplies guide content and version                                    |
| Dynamic picker options (installed apps, areas)                          | renders                         | ✅ `optionsFor(source)`                                                  |

The rule behind the split: **anything that decides whether a call may reach the upstream lives in core.** A buggy or malicious plugin can only lie about _inputs_ to the gate: classification hints, locked seeds, summaries. It cannot skip the gate, because core only calls `invoke` after the gate passes. Trusting a plugin's hints is part of the plugin trust decision (§4.3).

### 3.2 Manifest (`manifest.json`)

Validated by a zod schema in `@home-server-mcps/plugin-sdk`. Abridged example for Home Assistant:

```jsonc
{
  "id": "homeassistant", // globally unique, [a-z0-9-]
  "name": "Home Assistant",
  "version": "1.0.0", // semver
  "sdk": "^1.0.0", // plugin-SDK range this plugin was built for
  "description": "Search/execute over HA services and config flows.",
  "entry": "dist/index.js", // child-process entry, relative to the package root
  "binding": {
    "namespace": "ha", // sandbox global: ha.*
    "functions": ["call"], // ha.call(...)
    "searchApis": ["registry"], // extra read-only query APIs offered to search()
  },
  "labels": { "operation": "Operation", "operations": "Operations" }, // TrueNAS uses "Method(s)"
  "capabilities": {
    "registry": true, // produces registry entries (HA §2.4)
    "targets": true, // resolveTargets hook; pre-approval `targets` selector
    "attestation": true, // guides + best_practice_key (HA §3.6)
    "configTransform": true, // prepareWrite: diff + optimistic lock (HA §2.8)
  },
  "connection": {
    // rendered on the instance Connection page (§8.3)
    "schema": {
      "type": "object",
      "required": ["baseUrl", "token"],
      "properties": {
        "baseUrl": { "type": "string", "format": "uri", "title": "Base URL" },
        "token": { "type": "string", "title": "Long-lived access token", "writeOnly": true },
      },
    },
    "ui": { "token": { "widget": "secret", "help": "Profile → Security → Long-lived tokens" } },
  },
  "sensitiveKeys": ["access_token", "webhook_id", "entity_picture"],
  "network": { "hosts": ["{{connection.baseUrl}}"] }, // declared intent, shown on install (§4.4)
  "matchProfiles": {
    // reusable match-field sets, referenced by operations
    "light": [
      {
        "field": "$targets",
        "label": "Targets",
        "widget": "registry-picker",
        "options": { "kinds": ["area", "entity"], "domainFilter": "light" },
      },
    ],
    "climate.set_temperature": [
      {
        "field": "$targets",
        "label": "Targets",
        "widget": "registry-picker",
        "options": { "kinds": ["entity"], "domainFilter": "climate" },
      },
      {
        "field": "/temperature",
        "label": "Temperature",
        "op": "range",
        "widget": "range",
        "options": { "unit": "°F" },
      },
    ],
  },
}
```

Secret fields (`writeOnly: true`) are the only connection fields that are encrypted and never returned by the API (§7.2). Every other connection field is plain config.

### 3.3 RPC contract (core ⇄ plugin child)

Transport: the Node `child_process.fork` IPC channel, carrying JSON-RPC 2.0 messages. Each request has a timeout (default 30 s; `invoke` inherits the sandbox's remaining budget). The SDK's `runPlugin(handlers)` implements the child side, and the core `PluginHost` implements the parent side. All types are exported from `@home-server-mcps/plugin-sdk`.

| Method                                                                                 | Required             | Purpose                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init({ instanceId, config, secrets, sdkVersion })`                                    | ✅                   | Called once after spawn. The only time secrets cross the boundary.                                                                                                                                                                                                                                                                           |
| `testConnection()` → `{ ok, message?, upstreamVersion? }`                              | ✅                   | Connection page "Test connection". Rate-limited by core.                                                                                                                                                                                                                                                                                     |
| `getUpstreamVersion()` → `string`                                                      | ✅                   | Cheap version probe for version-triggered sync (TN §5).                                                                                                                                                                                                                                                                                      |
| `syncCatalog()` → `{ upstreamVersion, sourceRef?, operations: OperationDescriptor[] }` | ✅                   | Full catalog. Core diffs it into `operations` and marks missing rows `stale`.                                                                                                                                                                                                                                                                |
| `syncRegistry()` → `RegistryEntry[]`                                                   | if `registry`        | Mirror of pickable upstream objects (HA entities, areas, devices, floors).                                                                                                                                                                                                                                                                   |
| `resolveOperation(fn, args)` → `{ key, params }`                                       | ✅                   | Maps a raw binding call to a catalog key. TrueNAS: `call("pool.query", p)` → key `pool.query`. Seerr: `request({method:"POST", path:"/request", body})` → key `POST /request` via path-template matching. HA: `call("light.turn_on", p)` → key `light.turn_on`. An unknown operation throws, and core records `rejected: unknown_operation`. |
| `resolveTargets(key, params)` → `ResolvedTarget[]`                                     | if `targets`         | Expands area/device targets to concrete entities using the plugin's current registry view. **Must throw** on an unknown area or device (fail closed, HA §7 phase 4).                                                                                                                                                                         |
| `summarize(key, params, targets)` → `{ text, confirmLiteral? }`                        | ✅                   | The human sentence for approvals ("This will unlock **Front Door**"). `confirmLiteral` is the string the approver must type for locked operations (a dataset name, an entity friendly name).                                                                                                                                                 |
| `prepareWrite(key, params)` → `{ params, diff, expectedHash }`                         | if `configTransform` | Applies a transform against the current object. Throws `ConfigConflict` if the submitted hash is stale. Core shows the diff in the approval prompt and passes `expectedHash` back to `invoke`.                                                                                                                                               |
| `invoke(key, params, ctx)` → `unknown`                                                 | ✅                   | Performs the upstream call. Core calls it **only after the gate passes**. Upstream permission errors map to a structured `UpstreamDenied` error.                                                                                                                                                                                             |
| `optionsFor(source, query?)` → `{ value, label, meta? }[]`                             | optional             | Dynamic options for admin pickers, such as installed TrueNAS apps or Seerr media types.                                                                                                                                                                                                                                                      |
| `getGuide(key)` → `{ version, content }`                                               | if `attestation`     | Best-practice guide. Core hashes `(instance, key, version)` into the attestation key.                                                                                                                                                                                                                                                        |
| `shutdown()`                                                                           | ✅                   | Graceful stop.                                                                                                                                                                                                                                                                                                                               |

The child can also send **notifications**: `log`, and `catalogChanged` (for example, HA announcing a newly installed integration so core can schedule a sync early).

**`OperationDescriptor`**:

```ts
{
  key: string;                          // stable catalog key, unique per instance
  displayName?: string;
  kind: string;                         // plugin-defined: 'method' | 'rest' | 'service' | 'ws_command' …
  group: string;                        // access group (§5.2.1): TrueNAS namespace / Seerr tag / HA domain
  groupLabel?: string;                  // display name for the group, e.g. "Apps"
  tag?: string;                         // free-form filter tag; not used for access
  classification: 'read' | 'write';     // plugin's inferred default (naming / verb / command-shape)
  classificationReason: string;         // 'naming:.query' | 'verb:GET' | 'call_service-default' …
  locked?: boolean;                     // seeded locked (TN §3.4 / SR §3.4 / HA §3.4)
  typedConfirmation?: boolean;          // default: same as locked
  attestationRequired?: boolean;        // HA §3.6
  needsReview?: boolean;                // flag for the "New/Review" badge (SR GET-as-action, HA unknown WS command)
  matchProfile?: string;                // key into manifest.matchProfiles
  paramsSchema?: JSONSchema;            // for search() results and portal display
  docs?: { summary?: string; description?: string; guidance?: string };
}
```

### 3.4 How each source design maps onto the hooks

| Source behavior                                                                                                      | Plugin hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TN §2.2 `core.get_methods` / `core.get_services` sync                                                                | `truenas.syncCatalog`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TN §2.3 naming-convention inference and hardcoded locked list                                                        | `truenas.syncCatalog` sets `classification`, `locked`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Access groups (§5.2.1)                                                                                               | TrueNAS: method namespace (`app.upgrade` → `app`, `pool.dataset.create` → `pool.dataset`). Seerr: first OpenAPI tag (`request`, `settings`, `users`). HA: service domain (`light`, `lock`); config-flow commands by object type (`automation`, `script`, `dashboard`, `area`); read-side commands in `states` / `history` / `logbook`.                                                                                                                                                                                                                             |
| TN §6 wizard-style docs for dataset/app/share creation                                                               | `docs.guidance` on the descriptor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SR §2.2 fetching `seerr-api.yml` for the release tag matching `/status` (fallback `develop`, OpenAPI 3.0 validation) | `seerr.syncCatalog` (`sourceRef` recorded on the instance)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| SR §2.3 verb default, locked list, GET-as-action heuristic                                                           | `classification` from the verb, `locked`, `needsReview`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SR §3.4 on-behalf-of request approval is locked                                                                      | `seerr.resolveOperation` returns a distinct key (for example `POST /request/{id}/approve#on-behalf`) when the requester ≠ the Seerr user this connection signs in as. That key is seeded `locked`.                                                                                                                                                                                                                                                                                                                                                                 |
| SR §3.4 / §10 Seerr credential                                                                                       | Seerr has **no service accounts or per-user API keys**: one global `X-Api-Key` (acts as user 1, or as the user in `X-API-User`; invalidated by `POST /settings/main/regenerate`) and cookie sign-in via `POST /auth/local`. The connection defaults to **a dedicated local Seerr user** (email + password; works alongside Plex sign-in, needs Seerr's "Enable Local Sign-In"), with the global API key (+ optional `X-API-User`) as the alternative. The plugin re-signs in when the session cookie expires. Setup checklist in the manifest's `connection.help`. |
| HA §2.2 `get_services` + fixed WS command seed list, no `ws_command`                                                 | `ha.syncCatalog`. `resolveOperation` rejects anything not in the catalog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| HA §2.3 every `call_service` defaults to write                                                                       | `classification: 'write'` for every service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| HA §2.4 registry mirror, target resolution                                                                           | `ha.syncRegistry`, `ha.resolveTargets`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| HA §2.8 surgical config edits + `config_hash`                                                                        | `ha.prepareWrite`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| HA §3.4 garage-door `cover.open_cover` locked by device class                                                        | `locked` is per-operation, so the plugin emits a **target-conditional key** (`cover.open_cover#garage`) from `resolveOperation` when any resolved target has device class `garage`/`gate`. That key is seeded `locked`.                                                                                                                                                                                                                                                                                                                                            |
| HA §3.6 `BestPracticeKey`                                                                                            | `ha.getGuide` + `attestationRequired`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The last two rows show one general pattern: **when the risk of an operation depends on its params or targets, the plugin splits it into distinct catalog keys** in `resolveOperation`. This keeps `locked` a property of a catalog row, so it stays enforceable by core with a 409, and it keeps the gate generic.

---

## 4. Plugin Lifecycle & Distribution

### 4.1 Sources

| Source         | Location                                                                                                   | Trust                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Core**       | `plugins/*` in this repo, built into the image at `/app/plugins/<id>`                                      | Trusted (shipped with core, same review process) |
| **Repository** | Installed from an added plugin repo into `/data/plugins/<id>/` (one version at a time, swapped atomically) | Per-repo signing mode (§4.3)                     |

At startup the plugin host scans both locations, validates every `manifest.json` against the SDK schema and the `sdk` range, and upserts a `plugins` row. An invalid manifest is recorded with `status = 'invalid'` and an error message, and it is shown in the UI. It is never loaded.

**Every discovered plugin, core ones included, has an `enabled` flag** that is toggled in the Plugins page. New core plugins are discovered **disabled** unless `CORE_PLUGINS_AUTOENABLE=true`. That flag is set in the shipped compose example so a fresh install shows TrueNAS, Seerr, and HA ready to configure. Instances still have to be created explicitly. Disabling a plugin stops all its instances, and their endpoints return 503. Configuration and history are kept.

### 4.2 Plugin repositories (HACS-style index)

The admin adds a repository by URL on the Plugins → Repositories page. The URL points to an `index.json`:

```jsonc
{
  "schema": 1,
  "name": "Example community plugins",
  "homepage": "https://github.com/example/mcp-plugins",
  "publicKey": "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3", // optional, minisign/ed25519
  "plugins": [
    {
      "id": "unifi",
      "name": "UniFi Network",
      "description": "Search/execute over the UniFi controller API",
      "versions": [
        {
          "version": "0.3.1",
          "sdk": "^1.0.0",
          "minCoreVersion": "1.0.0",
          "url": "https://github.com/example/mcp-plugins/releases/download/unifi-0.3.1/unifi-0.3.1.tgz",
          "sha256": "9f2c…",
          "signature": "untrusted comment: …\nRWQ…", // required if the repo is signed
        },
      ],
    },
  ],
}
```

- The index is fetched when the repo is added, when someone clicks "Refresh", and daily. It is cached in `plugin_repos.index_cache`.
- The Plugins page lists available plugins across all repos. It shows the installed version and whether an update is available. **There are no automatic updates.** Every install or update is an explicit admin action on a pinned version.
- Tarballs contain a **prebuilt, self-contained** package: `manifest.json` plus the entry and everything it imports **inside the package directory**, typically a single bundle (`esbuild --bundle --platform=node`), which is how the core plugins are built. Under the permission model (§4.4) the child cannot read anything outside its directory, so an entry that imports from a shared `node_modules` fails to load. Discovery also rejects an entry whose real path (after symlinks) lies outside the directory. The server never runs `npm install` or build scripts. Archives may be flat or npm-pack style (one top-level `package/` directory). Extraction accepts only regular files and directories: links, devices, paths that escape the target, and archives over 50 MB compressed, 200 MB extracted or 5,000 entries all fail the install. The archive's manifest must name exactly the plugin id and version being installed.
- Plugin ID conflicts: a repository plugin cannot use a core plugin's ID. Two repos offering the same ID must be disambiguated at install time, and the installed row records its `repo_id`.

### 4.3 Trust & signing (optional per repo)

When the admin adds a repo, they choose a **signing mode**:

- **Signed.** Core reads `publicKey` from the index and shows it with its key id. The admin must confirm it by pasting the **full public key** (`RW…`, or the whole `.pub` file) exactly as the publisher advertises it out of band. A key id alone is not enough, because the key's owner chooses it: a hijacked index could publish a different key under the same id. The key is then **pinned** on the `plugin_repos` row. Every install requires the tarball to match `sha256` **and** carry a valid ed25519 (minisign-format) signature over the tarball bytes from the pinned key. If a later index fetch shows a different `publicKey` (compared byte for byte, not by id), the repo is marked `key_changed`: installs and updates are blocked until the admin re-confirms with the new full key. Both minisign algorithms are accepted (`ED`, prehashed with BLAKE2b-512 and the default since minisign 0.8, and legacy `Ed`), and the global signature over the trusted comment is always checked.
- **Unsigned.** Only `sha256` is verified. Every install from an unsigned repo shows a warning and requires typing the plugin ID to confirm. The plugin is badged "unsigned" everywhere it appears.

Installation, update, removal, and repo add/remove/key-change are written to the audit log as `config` events.

### 4.4 Process isolation

**Every enabled instance runs in its own child process**, core plugins included, so there is a single code path. The child is spawned by `child_process.fork(entry)` with:

- **Node permission model** (`--permission`), with `--allow-fs-read` limited to the plugin's package directory (Node's own runtime needs no grant; verified on Node 22: reads outside the directory, any write, and spawning processes all fail with `ERR_ACCESS_DENIED`). There is no `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, or `--allow-addons`. This follows the Node 22 permission model. The allow-list is set by core and cannot be widened by a plugin.
- **Scrubbed environment.** Only `NODE_ENV` and a `PLUGIN_INSTANCE_ID` are passed. `MASTER_KEY`, DB paths, and admin config are never visible.
- **Memory cap** via `--max-old-space-size` (default 256 MB, adjustable per instance).
- **Secrets arrive only via `init`** over IPC, decrypted by core for **that instance only**.
- **Supervision.** If the child crashes, the instance status becomes `error`. It restarts with exponential backoff (1 s → 60 s max), and the incident is audited and sent to notifiers (§9). While the child is down, in-flight `execute` calls fail with a structured `PluginUnavailable` error. The permission gate itself does not fail open; it never needs the plugin in order to _deny_.
- **Known limit: network egress is not restricted.** The Node permission model does not cover network access. A malicious plugin can reach any host the container can. The manifest's `network.hosts` is a _declaration_ shown at install time, not enforcement. Container-level egress policy is the documented mitigation, and per-plugin egress control is an open decision (§14).

---

## 5. Call Path & Permission Gate

### 5.1 `search(code)`

1. The code runs in a fresh `isolated-vm` context (§5.4).
2. Injected read-only APIs, all served by core from the DB (they never call the plugin):
   - `catalog.find({ text?, group?, tag?, kind?, classification?, includeDisabled? })` → descriptors. By default this returns **reachable operations only** (§5.2.1). When `includeDisabled` is set, unreachable operations are included and tagged `disabled` with their `reason` (`group_none`, `group_read_only`, `excluded`, `locked_not_opted_in`, `pending_review`) (TN §3.1).
   - `catalog.groups()` → `{ key, label, level, counts: { read, write, locked, pendingReview } }[]`, so the model can explain why something isn't callable ("TrueNAS apps are read-only on this endpoint").
   - `catalog.get(key)` → the full descriptor with `paramsSchema` and docs.
   - `registry.find({ kind?, text?, parent?, domain? })` (only if the plugin has `registry`) → matched entries only, never the whole registry (HA §2.4).
   - `guides.get(key)` (only if `attestation`) → `{ content, best_practice_key }`. The key is `HMAC(server_secret, instance ‖ key ‖ guideVersion)`. Handing out a key is recorded in the audit log.
3. The return value is redacted (§5.5), size-capped (default 64 KB, truncated with a marker), and audited as a `search` event.

### 5.2 `execute(code)` and the binding

The sandbox receives `<namespace>.<fn>(...)` for each function in `manifest.binding.functions`. Each call runs this pipeline:

```
binding(args)
  │
  ├─ 0. resolveOperation (plugin)      → key, params         | unknown → UnknownOperation
  ├─ 1. attestation (if op.attestation_required)             | AttestationRequired      (HA §3.6)
  ├─ 2. access (group level + op state, §5.2.1)              | OperationDisabled{reason}
  ├─ 3. resolveTargets (plugin, if capability)               | TargetResolutionFailed   (fail closed)
  ├─ 4. prepareWrite (plugin, if configTransform & write)    | ConfigConflict           (HA §2.8)
  ├─ 5. classification (effective = locked ▸ override ▸ inferred)
  │      read  → invoke
  │      write/locked:
  ├─ 6. pre-approval (skip if locked)  match & unexpired & under rate limit → invoke (auto-approved:<rule>)
  ├─ 7. human approval (§5.3)          approved → invoke | denied/timeout → PermissionDenied
  ├─ 8. invoke (plugin)                                       | UpstreamDenied / UpstreamError
  ├─ 9. redact result (§5.5)
  └─ 10. audit (every branch above, including rejections)
```

- Errors are thrown **into** the sandbox as catchable `Error`s with a `code` property. They never crash the host (TN §3.1.6). Codes: `UNKNOWN_OPERATION`, `ATTESTATION_REQUIRED`, `OPERATION_DISABLED` (message says why: group none/read-only, excluded, locked not opted in, pending review), `TARGET_RESOLUTION_FAILED`, `CONFIG_CONFLICT`, `PERMISSION_DENIED` (denied, timed out, no approval path), `RATE_LIMITED`, `UPSTREAM_DENIED`, `UPSTREAM_ERROR`, `UPSTREAM_TIMEOUT`, `PLUGIN_UNAVAILABLE`, `PLUGIN_ERROR`.
- `prepareWrite` (step 4) runs for write operations whose descriptor `kind` is `config`, on plugins that declare `configTransform`.
- Calls are serialized within one `execute` by default. While one call waits for approval, the whole `execute` blocks (TN §3.1.4). Per-instance setting: `concurrentReadsDuringApproval` (default `false`).
- **Rate limiting.** Per-instance `execute` calls per minute (default 30) and upstream write calls per minute (default 10). Exceeding a limit throws `RateLimited`. This is separate from pre-approval rule rate limits.
- **Pre-approval match evaluator** (generic, core). A rule's `match` is a list of conditions. Every condition must hold (AND):
  - `{ field: "/json/pointer", op: "eq" | "in" | "prefix" | "range" | "bool", value }` is evaluated against the **normalized params**. A missing field means **no match**.
  - `{ field: "$targets", areas?: [], entities?: [], domains?: [] }` holds only if **every** resolved target satisfies **all** the set selectors (HA §3.5). Zero resolved targets means no match.
  - A rule with an empty `match` matches any params. The UI shows a warning for this (TN §3.5).
  - `rate_limit` / `window_seconds` are enforced via `pre_approval_hits`. When the limit is hit, the call **falls back to human approval** instead of being rejected.

### 5.2.1 Group access (replaces per-operation Enabled toggles)

Admins don't toggle operations one by one. Every operation belongs to an **access group** that the plugin derives during discovery (§3.4). The admin sets **one level per group**:

| Level   | Read operations | Write operations                                                                           | Locked operations                       |
| ------- | --------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| `none`  | hidden          | hidden                                                                                     | hidden                                  |
| `read`  | reachable       | hidden                                                                                     | hidden                                  |
| `write` | reachable       | reachable once **acknowledged**, and every call still goes through approval / pre-approval | hidden until **opted in** per operation |

`write` means _reachable_, not _auto-approved_. Classification, pre-approval rules, human approval, and typed confirmation all apply exactly as in §5.2–§5.3.

**Reachability**, as one pure function in core (`packages/core/src/gate/access.ts`). The gate, `search`, and the portal all use it:

```
reachable(op, group):
  group missing / unknown level        → no  (group_missing)       -- fail closed
  group.level == 'none'                → no  (group_none)
  op.excluded                          → no  (excluded)
  op is read (and not locked)          → yes
  group.level == 'read'                → no  (group_read_only)
  op.locked && !op.locked_opt_in       → no  (locked_not_opted_in)
  !op.write_acknowledged               → no  (pending_review)
  otherwise                            → yes
```

**Per-operation state (exclude-only).** The group level is the ceiling; an operation can only be narrowed below it:

- `excluded` removes one operation, e.g. group `app` at `write` but `app.rollback` excluded.
- `locked_opt_in` exposes a single locked operation in a group at `write`. Opting in also acknowledges it. Locked operations still need typed confirmation and can never be pre-approved.
- There is no per-operation _grant_. To expose one write in a group, raise the group to `write` and exclude the rest.

**Acknowledgement / quarantine.**

- Raising a group to `write` opens a confirmation listing the non-locked writes it will expose. Confirming acknowledges exactly those operations (audited).
- Write operations that appear in **later syncs** start with `write_acknowledged = false` and stay unreachable, even in a group already at `write`. The group shows "N pending review", and a `sync.pending_review` notification is sent (§9).
- If a sync changes an operation's inferred classification from read to write, its acknowledgement is reset.
- An admin override that makes an operation `write` counts as acknowledging it.
- New _read_ operations are reachable immediately in groups at `read` or `write`.

**Defaults.** A newly discovered group starts at `read`. Every endpoint therefore starts read-only without any pre-approval rules. HA service groups (`light`, `lock`…) at `read` expose nothing, because every `call_service` is a write (HA §2.3).

**Bulk actions** (Access page):

- "All groups → None" and "All groups → Read" run immediately, because they only reduce access. They are audited.
- **"All groups → Write"** requires a confirmation dialog listing, per group, how many non-locked writes will be exposed, and the admin must **type the instance slug**. It acknowledges exactly the previewed operations (the API rejects the request with 409 if the preview is stale, e.g. a sync added operations in between). Locked operations stay off and still need their own opt-in. Writes discovered later are still quarantined. It is audited as one `config` event with every group's before/after level.

**Regrouping.** The plugin's grouping is the default. The admin can **merge** groups (e.g. fold `app.image` into `app`) and **rename** labels. Merges are stored as aliases (`plugin_group → group_key`) and applied on every sync, so custom grouping survives re-discovery. Merging groups with different levels takes the **lower** level.

**Pre-approval rules** still target individual operations. A rule on an unreachable operation is inert, and the rule list flags it ("operation not reachable: group is read-only").

### 5.3 Human approval

1. Core creates a `pending_approvals` row containing: instance, operation key, normalized params (redacted copy for display), `params_hash` (SHA-256 over canonical JSON of key + params + resolved targets + expected hash), summary, `confirm_literal`, diff, the requesting client identity, the MCP session, `expires_at` (default now + 15 min, set per instance).
2. **Delivery channels, all at once.** The first decision to arrive wins; the rest are cancelled.
   - **Elicitation.** Used if the session's client advertised `elicitation` and the session is live. Core calls `server.elicitInput({ message, requestedSchema })`. The schema contains an `approve` boolean, plus a `confirm` string when typed confirmation is required. The message includes the summary, key, redacted params, and diff. `decline` (or `approve: false`) denies. `cancel` (dismissed without deciding) leaves the request open for the portal, links or the timeout.
   - **Portal inbox.** Always on. The Pending Approvals page on the admin port.
   - **Notifiers.** ntfy and webhook channels subscribed to `approval.pending` (§9), carrying approve/deny links to the MCP-port approval page.
3. **Typed confirmation.** For `typedConfirmation` operations, an approval only counts if the approver typed `confirm_literal` exactly. This applies on every channel. An elicitation answer with a mismatched literal counts as a denial. In the portal, a mismatched literal is rejected (400) and the admin can retry. The literal comes from the plugin's `summarize`, which receives **redacted** params, so neither the summary nor the literal can carry a secret. If a typed-confirmation operation gets no literal, the call is refused.
4. **Single use.** An approval authorizes exactly one `invoke` of exactly the `params_hash` it was created for (TN §3.3). A re-submitted call creates a new approval.
5. **No channel available.** If the client lacks elicitation and the instance has `allowPortalOnlyApprovals = false`, the call is denied immediately and logged `denied: no_approval_path` (TN §3.3). The default is `true`, because the portal inbox always exists.
6. **Timeout** → auto-deny, logged `timed-out`. It is never auto-allowed.

### 5.4 Sandbox

- `isolated-vm`. **One isolate per `execute`/`search` invocation**, disposed afterwards. It is never reused across requests (TN §4).
- Runtime: `isolated-vm` **6.2** (7.x requires Node 24; the image runs Node 22), loaded from its shipped prebuilds, with `node --no-node-snapshot` as isolated-vm requires on Node ≥ 20.
- `code` is the **body of an async function**: it can `await` bindings and `return` a JSON-serializable result. Everything crosses the boundary as JSON. Errors thrown inside the isolate, including binding errors, come back as `{ code, message }`, and a binding error is a real `Error` with `err.code` inside the sandbox so the model's code can catch it.
- Limits per call (instance-overridable): wall-clock 10 s _excluding time blocked on human approval_ (the binding pauses the budget while waiting; the approval timeout bounds the wait), memory 64 MB, result size 64 KB (larger results come back as `{ truncated, bytes, preview }`), logs 16 KB. The budget covers both synchronous loops (V8 timeout) and async loops (the isolate is disposed when it runs out).
- Injected: the binding functions (`ivm.Reference` with promise results), `catalog`/`registry`/`guides` (search only), and `console.log` (captured and returned as a `logs` array, size-capped).
- Not available: `require`, `import`, `process`, `fetch`, timers (`setTimeout` is not provided), and host objects. Binding namespaces are frozen, and the host call/log references are removed from the global scope before user code runs. This follows from the isolate having no Node APIs. An optional static pre-scan (TN §3.2) rejects obvious escape attempts early as defense in depth.

### 5.5 Redaction

A core engine walks results, params, and summaries and replaces values with `"[REDACTED]"` for any key matching:

- the global list: `password`, `passphrase`, `secret`, `token`, `apiKey`, `api_key`, `privateKey`, `private_key`, `bindpw`, `authPass`
- the plugin's `sensitiveKeys`
- the instance's extra keys, configured in the portal

It is applied (a) to results returned to the model, (b) to everything written to the audit log and pending approvals, and (c) to anything rendered in the portal. For approval integrity, the unredacted params are held **only in memory** while the call is pending. The DB stores the redacted display copy plus `params_hash`. On restart, pending approvals are **auto-denied** (`denied: server_restart`), because the in-memory params are gone. This is intentional: an approval must never cover params the approver did not see.

---

## 6. Authentication

### 6.1 Admin portal login (port 8081)

- **Local users** (`users` table): username + argon2id password hash (`m=64 MiB, t=3, p=1`). There are no roles; every user is an admin.
- **First-run setup.** If no users exist, the SPA shows a one-time **Setup** screen to create the first user. The setup endpoint is **only** available while the users table is empty. Alternative for headless installs: `ADMIN_BOOTSTRAP_USERNAME` + `ADMIN_BOOTSTRAP_PASSWORD` create the first user on boot if the table is empty. After that they are ignored, and a warning is logged if they are still set.
- **TOTP (optional, per user).** RFC 6238, enrolled from the user's profile with a QR code. The secret is encrypted with the master key. Ten single-use recovery codes are generated (stored hashed). Setting `security.requireTotp` forces enrollment on next login.
- **OIDC (optional).** Configured in Settings → Authentication with: issuer URL (discovery), client ID/secret (secret encrypted), scopes, and an **allow policy** (allowed emails, allowed `sub`s, and/or a required group claim value). Auth code flow + PKCE, with `state` and `nonce`.
  - `autoProvision` (default **off**): if off, an OIDC identity must be **linked** to an existing local user first (Profile → "Link OIDC identity"). If on, identities that pass the allow policy get a user created automatically.
  - **Break-glass.** Local password login always remains available unless `security.disableLocalLogin = true`. That setting can only be saved while at least one OIDC-linked user exists, and it can be reverted with the env var `ADMIN_FORCE_LOCAL_LOGIN=true`.
- **Sessions.** Stored server-side (`sessions` table, random 256-bit ID, stored hashed). Cookie: `__Host-hsm_admin` (`Secure` when behind TLS, `HttpOnly`, `SameSite=Strict`, `Path=/`). Idle timeout 30 min, absolute 12 h. Logout deletes the row. Changing a password revokes the user's other sessions.
- **CSRF.** A double-submit token: a non-HttpOnly `hsm_csrf` cookie plus an `X-CSRF-Token` header on every state-changing `/api/*` request. `Origin` is also checked against `PUBLIC_ADMIN_URL` when that is set.
- **Brute-force protection.** 5 failed logins per username per 15 min triggers a 15 min lockout. There is also a per-IP token bucket on `/auth/*` and `/api/instances/:id/connection/test` (the credential-testing-oracle concern from TN §4). Login failures are audited as `auth` events.

### 6.2 MCP endpoint authentication (port 8080)

The auth mode is a **global default** (Settings → MCP Access) with an optional **per-instance override** (Instance → Settings):

| Mode           | Accepts                                                                                                                                                                                                                                                                                                                                                                | Client identity recorded                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `external`     | Anything that reaches the port. The reverse proxy is trusted to authenticate. Optional **Cloudflare Access JWT verification**: if `teamDomain` + `aud` are configured, the `Cf-Access-Jwt-Assertion` header must verify against the team's JWKS. Optional generic **trusted identity header** (e.g. `Remote-User` from Authelia/Authentik), used only for attribution. | JWT email / header value / `"external"`    |
| `bearer`       | `Authorization: Bearer hsm_…` tokens issued in the portal                                                                                                                                                                                                                                                                                                              | Token name                                 |
| `oauth`        | OAuth 2.1 access tokens issued by the built-in authorization server                                                                                                                                                                                                                                                                                                    | OAuth client name + the user who consented |
| `bearer+oauth` | Either of the above                                                                                                                                                                                                                                                                                                                                                    | as above                                   |

The UI shows a warning when `external` is chosen without JWT verification, because in that case port 8080 must never be reachable except through the proxy.

**Bearer tokens** (Clients & Tokens page):

- Format `hsm_<base62 32 bytes>`. Shown **once** at creation and stored as SHA-256.
- Fields: name, **scope** (a list of instance IDs, or `*` for all), optional expiry, `last_used_at`, revoke.
- A token presented to an endpoint outside its scope gets **403**, not 401.

**Built-in OAuth 2.1 authorization server** (MCP authorization spec):

- **Protected-resource metadata** (RFC 9728) at `/.well-known/oauth-protected-resource/{slug}`, naming `PUBLIC_MCP_URL` as the authorization server. An unauthenticated request to `/{slug}` gets 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/{slug}"`.
- **AS metadata** (RFC 8414) at `/.well-known/oauth-authorization-server`.
- **Dynamic client registration** (RFC 7591) at `/oauth/register`. It can be switched off globally (`oauth.allowDynamicRegistration`). If off, clients are pre-registered on the Clients & Tokens page. Registered clients are listed there with their redirect URIs and can be revoked.
- `/oauth/authorize`: authorization code flow, **PKCE S256 required**, and a `resource` parameter (RFC 8707) that must be one or more instance URLs. The user logs in on the minimal MCP-port login page (local password + TOTP, or OIDC), then sees a **consent screen** listing the client name, its redirect URI host, and the **endpoints requested**. The user can narrow the endpoint list before approving.
- `/oauth/token`: access tokens are opaque and short-lived (1 h), stored hashed, with audience = the granted resources. Refresh tokens rotate on every use (30 d sliding window, family revoked on reuse detection).
- Consent grants are listed per user and client on the Clients & Tokens page and can be revoked.

**Scope enforcement is the same for both token kinds.** Every request to `/{slug}` checks that the presented credential's scope or audience includes that instance.

---

## 7. Data Model

A single SQLite file at `DATA_DIR/hsm.sqlite` (default `/data`), opened with **better-sqlite3** in WAL mode. Schema and migrations are managed with **Drizzle** (`packages/core/src/db/schema.ts`, `packages/core/drizzle/`). JSON is stored as `TEXT`, following the source docs.

### 7.1 Tables

```
-- identity & admin auth
users(id, username UNIQUE, password_hash NULL, totp_secret_enc NULL, totp_enabled, recovery_codes_hash TEXT,
      oidc_issuer NULL, oidc_subject NULL, created_at, last_login_at, disabled)
sessions(id_hash PK, user_id FK, kind 'admin'|'oauth_ui'|'approval_ui', created_at, last_seen_at, expires_at, ip, user_agent)
settings(key PK, value TEXT)                                   -- auth defaults, rate limits, flags; JSON values
oidc_config(id=1, issuer, client_id, client_secret_enc, scopes, allow_policy TEXT, auto_provision, enabled)

-- plugins
plugin_repos(id, url UNIQUE, name, signing_mode 'signed'|'unsigned', public_key NULL, key_fingerprint NULL,
             key_status 'ok'|'key_changed', index_cache TEXT, last_fetched_at, last_fetch_error)
plugins(id, plugin_id, version, source 'core'|'repo', repo_id NULL FK, path, sha256 NULL, signature_verified,
        manifest TEXT, status 'ok'|'invalid'|'incompatible', status_error, enabled, installed_at,
        UNIQUE(plugin_id))                                     -- one installed version per plugin id
plugin_instances(id, plugin_id FK, slug UNIQUE, display_name, enabled, config TEXT, secrets_enc BLOB,
                 auth_mode NULL,                                -- NULL = inherit global default
                 settings TEXT,                                 -- approval timeout, rate limits, sandbox limits…
                 status 'stopped'|'starting'|'ready'|'error', status_error,
                 upstream_version, source_ref, last_synced_at, last_sync_status, created_at)

-- catalog (instance-scoped; replaces methods/operations tables of TN/SR/HA)
operation_groups(id, instance_id FK, key, label, level 'none'|'read'|'write' DEFAULT 'read',
                 level_changed_at, level_changed_by FK users, first_seen_at, stale, UNIQUE(instance_id, key))
operation_group_aliases(instance_id FK, plugin_group, group_key, UNIQUE(instance_id, plugin_group))  -- admin regrouping
operations(id, instance_id FK, key, display_name, kind, tag,
           classification 'read'|'write',                       -- effective (locked implies write)
           classification_source 'locked'|'override'|'inferred',
           inferred_classification, inferred_reason,
           plugin_group, group_id FK operation_groups,
           locked, excluded, locked_opt_in, write_acknowledged, acknowledged_at, acknowledged_by,
           typed_confirmation, attestation_required, needs_review,
           match_profile, params_schema TEXT, docs TEXT,
           first_seen_at, last_seen_at, stale,
           UNIQUE(instance_id, key))
registry_entries(id, instance_id FK, kind, ext_id, name, parent_ext_id, domain, attrs TEXT, stale, last_synced_at,
                 UNIQUE(instance_id, kind, ext_id))
guides(id, instance_id FK, operation_id FK, version, content, fetched_at)

-- permission gate
pre_approval_rules(id, instance_id FK, operation_id FK, match TEXT, rate_limit, window_seconds, expires_at,
                   reason NOT NULL, enabled, created_by FK users, created_at, updated_at, last_triggered_at)
pre_approval_hits(id, rule_id FK, occurred_at)
pending_approvals(id, instance_id FK, operation_id FK, params_display TEXT, params_hash, resolved_targets TEXT,
                  summary, confirm_literal NULL, diff TEXT NULL, expected_hash NULL,
                  client_kind, client_id, mcp_session_id, requested_at, expires_at,
                  status 'pending'|'approved'|'denied'|'timed_out'|'cancelled',
                  decided_by NULL, decided_via 'elicitation'|'portal'|'link' NULL, decided_at NULL)
audit_log(id, at, kind 'call'|'search'|'config'|'auth'|'plugin', instance_id NULL, operation_key NULL,
          classification NULL, decision NULL,  -- auto-executed | auto-approved:rule:<id> | human-approved | denied |
                                               -- timed-out | rejected:<reason>
          actor_kind 'mcp_client'|'user'|'system', actor_id, decided_by NULL, decided_via NULL,
          params TEXT NULL, resolved_targets TEXT NULL, result_status NULL, duration_ms NULL,
          detail TEXT NULL)                    -- config diffs, auth failures, plugin crashes

-- MCP client auth
mcp_tokens(id, name, token_hash UNIQUE, scope TEXT, created_by, created_at, expires_at, last_used_at, revoked_at)
oauth_clients(id, client_id UNIQUE, client_secret_hash NULL, name, redirect_uris TEXT, registered_via 'dcr'|'admin',
              created_at, revoked_at)
oauth_grants(id, client_id FK, user_id FK, resources TEXT, created_at, revoked_at)
oauth_codes(code_hash PK, grant_id FK, code_challenge, redirect_uri, resources TEXT, expires_at, used_at)
oauth_tokens(token_hash PK, grant_id FK, kind 'access'|'refresh', family_id, resources TEXT, expires_at, revoked_at)

-- notifications
notifier_channels(id, kind 'ntfy'|'webhook', name, config TEXT, secrets_enc BLOB, events TEXT, instance_filter TEXT,
                  enabled, last_sent_at, last_error)
approval_links(token_hash PK, approval_id FK, action 'approve'|'deny'|'view', expires_at, used_at)
```

### 7.2 Secrets & master key

- `MASTER_KEY` (32 bytes, base64) comes from env. If unset, core reads or creates `DATA_DIR/master.key` (0600) on first boot and logs a prominent warning recommending that the key be moved out of the data volume.
- Encryption: AES-256-GCM with a random 96-bit nonce per value. The ciphertext blob is `v1 ‖ nonce ‖ ciphertext ‖ tag`, and the AAD is `table:column:row-id`, so a ciphertext can't be copied to another row.
- Encrypted columns: `plugin_instances.secrets_enc` (all `writeOnly` connection fields), `users.totp_secret_enc`, `oidc_config.client_secret_enc`, `notifier_channels.secrets_enc`.
- The Admin API **never returns decrypted secrets**. `GET` returns `{ set: true, hint: "…ab12" }` per secret field. `PUT` with a secret field replaces it. Omitting the field keeps the old value (TN §2.6).
- Key rotation: `node dist/cli.js rotate-master-key`, run with the server stopped, decrypts every encrypted column first and then re-encrypts them all in one transaction, so a wrong current key changes nothing. With a key file, the new key is written to `master.key.new` before the database changes and then moved over `master.key`. With `MASTER_KEY` in the environment, the replacement must be supplied as `NEW_MASTER_KEY`, so it exists before any data depends on it. All sessions are cleared, because their pepper is derived from the master key.
- Derived keys (HKDF from the master key): the attestation HMAC key, the signed-state key (MFA and consent forms), and the session-ID pepper. Approval-link tokens are random and stored as SHA-256 hashes, so they need no key.

### 7.3 Write ownership (TN §8, adapted)

| Writer                               | Tables                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin API (authenticated user)       | `users`, `settings`, `oidc_config`, `plugin_repos`, `plugins`, `plugin_instances`, `operation_groups.{level, label}`, `operation_group_aliases`, `operations.{classification_source=override, excluded, locked_opt_in, write_acknowledged, attestation_required}`, `pre_approval_rules`, `mcp_tokens`, `oauth_clients` (admin), `notifier_channels`, `pending_approvals.status` (portal decisions) |
| Sync jobs (core, from plugin output) | `operations` (insert, inferred fields, `stale`, `last_seen_at`, locked seeds, `write_acknowledged` reset on read→write), `operation_groups` (insert at `read`, `stale`), `registry_entries`, `guides`, instance sync columns                                                                                                                                                                       |
| Gate / approval service              | `pending_approvals`, `pre_approval_hits`, `audit_log`                                                                                                                                                                                                                                                                                                                                              |
| OAuth AS                             | `oauth_*`, `sessions(kind=oauth_ui)`                                                                                                                                                                                                                                                                                                                                                               |
| Nobody (append-only)                 | `audit_log` rows are never updated or deleted through any API                                                                                                                                                                                                                                                                                                                                      |

Invariants, enforced in the service layer and tested:

- `locked` can only be set by sync from a plugin seed, and never cleared through the API. `PATCH` on the classification of a locked row returns 409.
- A `pre_approval_rules` row can never reference a locked operation. `POST`/`PATCH` return 409. A sync that newly locks an operation **disables** any existing rules on it and audits that.
- An operation with no group row is unreachable (`group_missing`). A group can only be raised to `write` together with the exact list of writes being acknowledged; a stale list returns 409.
- `excluded`, `locked_opt_in`, and group levels are changed only through the Admin API, and every change is audited.
- Sandboxed code and plugin children have **no path** to any of these tables.

---

## 8. Admin Portal UI

Vue 3 + Vite + vue-router + Pinia, served as static assets by the admin listener. The visual language follows the mockups: a dark sidebar, light content area, pill badges for `read`/`write`/`locked`, and the toggle style from `Methods.dc.html`.

### 8.1 Navigation

```
┌ Sidebar ───────────────────┐
│ ▣ MCP Admin                │
│                            │
│ Overview                   │  Endpoints dashboard (§8.2)
│ Pending Approvals   (3)    │  global inbox, all instances
│ Audit Log                  │  global
│                            │
│ ENDPOINTS                  │
│ ▾ /truenas   ● Ready       │  instance group (expands when selected)
│     Connection             │
│     Access                 │  group levels (§5.2.1)
│     Pre-Approval Rules     │
│     Settings               │
│ ▸ /seerr     ● Ready       │
│ ▸ /ha        ● Error       │
│ + New endpoint             │
│                            │
│ Plugins                    │
│ Clients & Tokens           │
│ Settings                   │
│ ─────────────────────────  │
│ admin · Log out            │
└────────────────────────────┘
```

The per-instance pages are the mockup pages (Connection, Methods, Pre-Approval Rules), now scoped to one instance. Pending Approvals and Audit Log are global, with an instance filter and an instance column.

### 8.2 Pages

| Page                                    | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login**                               | Username/password, TOTP step if enabled, a "Sign in with <provider>" button when OIDC is enabled, and lockout messaging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Setup**                               | Only while no users exist: create the first admin and optionally enroll TOTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Overview**                            | A card per instance: plugin, slug, full endpoint URL (copy button), auth mode (inherited or overridden), status, last sync, pending count. Plus plugin child health and notifier health.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Connection** _(per instance)_         | The `Main.dc.html` mockup, driven by the plugin's `connection` schema: fields, secret fields with a masked hint + "Rotate", Save, Test connection, status pill, Sync now, last synced, upstream version, count of synced operations, new since last sync, `sourceRef` (Seerr). Plugin-provided help (`connection.help`) and conditional fields (`showWhen`, §8.3), e.g. Seerr's local-user setup checklist and API-key rotation warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Access** _(per instance)_             | Replaces the per-operation Enabled toggles of `Methods.dc.html` (that mockup predates §5.2.1; its row styling and badges still apply). A **group list**: label and key, a None / Read / Write segmented control, counts of read / write / locked operations, a "N pending review" badge, and NEW / STALE badges. Changing a group to Write opens the acknowledgement dialog (§5.2.1). **Expanding a group** lists its operations (using `manifest.labels`, e.g. "Methods" for TrueNAS): key, classification dropdown (disabled with a lock icon on locked rows), source, last seen, NEW / REVIEW / STALE badges, an **Exclude** toggle, **Allow** on locked operations (only while the group is at Write), **Acknowledge** on pending writes, and the `attestation_required` toggle (only for plugins with `attestation`). Page tools: search across all groups and operations, "Needs review" filter, **Regroup** dialog (merge / rename), and bulk **All → None / Read / Write** (Write needs the typed-slug confirmation). |
| **Pre-Approval Rules** _(per instance)_ | The `PreApprovalRules.dc.html` mockup: rule list with rate limit and last triggered. Editor: operation picker (a searchable catalog list, **locked operations not offered**), match editor rendered from the operation's `matchProfile` (§8.4), rate limit, expiry, required reason, enabled. Warning banner for an empty match.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Instance Settings** _(per instance)_  | Display name, slug (renaming warns that clients must be reconfigured), enabled, auth-mode override, approval timeout, `allowPortalOnlyApprovals`, rate limits, sandbox limits, extra redaction keys, memory cap. Delete instance (typed confirmation of the slug; history is kept in the audit log).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Pending Approvals**                   | The `PendingApprovals.dc.html` mockup, across instances: instance, operation + badge, summary, params (redacted), resolved targets with friendly names, diff (for config transforms), rule-miss reason, requested-by client, countdown, Approve (with a typed-confirmation input when needed) / Deny. Updates live over SSE from `/api/events`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Audit Log**                           | The `AuditLog.dc.html` mockup, plus columns for instance, kind, and actor. Filters: instance, kind (`call`/`search`/`config`/`auth`/`plugin`), decision, time range, operation, target entity. CSV export. Clicking an `auto-approved` row opens the rule and its edit history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Plugins**                             | Tabs. **Installed**: source, version, signed/unsigned badge, status, enable toggle, instances using it, update available, uninstall (blocked while instances exist). **Available**: across repos, with install + permission/network declaration review. **Repositories**: add a URL, choose the signing mode, confirm the key fingerprint, refresh, key-changed banner, remove.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Clients & Tokens**                    | Bearer tokens (create with scope and expiry, shown once, revoke), OAuth clients (DCR + admin-registered, revoke), OAuth grants per user (revoke).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Settings**                            | _MCP Access_: default auth mode, Cloudflare Access config, trusted identity header, DCR on/off, `PUBLIC_MCP_URL` display. _Authentication_: OIDC config + allow policy + auto-provision, require TOTP, disable local login. _Users_: list/add/disable users, reset TOTP. _Notifications_: channels (§9). _Profile_: change password, TOTP enroll/reset, link OIDC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 8.3 Declarative plugin UI

Plugins never ship JavaScript to the admin origin. The places where plugin-specific UI is needed use JSON Schema + UI hints rendered by a **fixed core widget library**:

| Widget                                    | Used for                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`, `url`, `number`, `bool`, `select` | connection fields, scalar match fields                                                                                                                                                                                                                        |
| `secret`                                  | write-only credential fields (masked hint, rotate)                                                                                                                                                                                                            |
| `multiselect`                             | static options, or dynamic via `optionsFor(source)` (e.g. TN "app in: plex, sonarr"; mockup `PreApprovalRules.dc.html`)                                                                                                                                       |
| `prefix`                                  | path/name prefix match (TN `pool.dataset.create` name prefix)                                                                                                                                                                                                 |
| `range`                                   | numeric range with unit (HA thermostat 65–78 °F)                                                                                                                                                                                                              |
| `registry-picker`                         | HA Option A (`OptionA.dc.html`): a "Match by" segmented control (Area / Entity / Domain), a checkbox list with live entity counts, an optional narrowing entity search, and a separate optional domain dropdown. Backed by `GET /api/instances/:id/registry`. |
| `diff`                                    | before/after field diff in Pending Approvals (HA §2.8)                                                                                                                                                                                                        |

Adding a widget is a core change. Plugins can only reference widgets that exist. An unknown widget name in a manifest fails validation, so a plugin cannot silently degrade to a free-text field.

Connection fields can also carry `showWhen: { field, in: [...] }` to appear only for certain values of another field (e.g. Seerr shows email/password for `authMethod = local` and the API key for `apiKey`). The manifest's `connection.help` (Markdown) is rendered above the form as a setup checklist. Conditional _requirements_ are expressed in the JSON Schema itself (`allOf` + `if`/`then`) and validated server-side.

### 8.4 Admin API (summary)

All routes are under `/api` on port 8081, need a session cookie and CSRF for mutations, and return JSON.

```
POST   /auth/login | /auth/totp | /auth/logout      GET /auth/oidc/start | /auth/oidc/callback
GET    /api/session                                  POST /api/setup (only while no users)
GET    /api/overview
GET    /api/plugins            PATCH /api/plugins/:id {enabled}        DELETE /api/plugins/:id
GET/POST/DELETE /api/plugin-repos    POST /api/plugin-repos/:id/refresh | /confirm-key {publicKey}
GET    /api/plugin-repos/available   POST /api/plugins/install {repoId, pluginId, version, confirm}
GET/POST /api/instances      GET/PATCH/DELETE /api/instances/:id
GET/PUT  /api/instances/:id/connection   POST /api/instances/:id/connection/test
POST   /api/instances/:id/sync
GET    /api/instances/:id/groups          PATCH /api/instances/:id/groups/:key {level?, label?, acknowledge?}
                                          (level=write requires acknowledge = exact list of writes exposed; 409 if stale)
POST   /api/instances/:id/groups/merge {from: [keys], into, label?}
GET    /api/instances/:id/groups/bulk-level/preview?level=write
POST   /api/instances/:id/groups/bulk-level {level, confirm?, acknowledge?}   (write: confirm = slug, acknowledge = preview; 409 if stale)
GET    /api/instances/:id/operations?group=&q=&reason=
PATCH  /api/instances/:id/operations/:opId {excluded?, lockedOptIn?, acknowledged?, classification?, attestationRequired?}
                                          (409 on locked classification)
GET    /api/instances/:id/registry        GET /api/instances/:id/options/:source
GET/POST /api/instances/:id/rules         PATCH/DELETE /api/instances/:id/rules/:ruleId (409 on locked op)
GET    /api/approvals              POST /api/approvals/:id/approve {confirm?} | /deny
GET    /api/audit                  GET /api/audit/export.csv
GET/POST/DELETE /api/tokens        GET/DELETE /api/oauth/clients   GET/DELETE /api/oauth/grants
GET/PUT  /api/settings/:section    GET/POST/PATCH/DELETE /api/users
GET/POST/PATCH/DELETE /api/notifiers   POST /api/notifiers/:id/test
GET    /api/events  (SSE: approvals, instance status, sync progress)
```

Every mutating route writes a `config` audit event with a before/after diff (secrets redacted). The "configuration changes" filter asked for in TN §6 is the `kind=config` filter.

---

## 9. Notifications (v1)

### 9.1 Channels

| Kind      | Config                                                                           | Delivery                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ntfy`    | server URL (default `https://ntfy.sh`), topic, optional access token (encrypted) | JSON publish to `POST {server}` (`topic`, `title`, `message`, `priority`, `tags`, `click`, and `actions`: view Approve / view Deny links). JSON rather than headers so titles stay UTF-8 safe                         |
| `webhook` | URL, optional HMAC secret (encrypted), optional extra headers (encrypted)        | `POST` JSON `{event, at, instance, title, message, data, links?}` with `X-HSM-Event`, `X-HSM-Timestamp` and `X-HSM-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + body)>`, so a receiver can reject replays |

Each channel subscribes to a set of **events** and can filter by instance:

- `approval.pending`, `approval.decided`, `approval.timed_out`
- `instance.error`, `instance.recovered`, `plugin.crashed`
- `sync.failed`, `sync.pending_review` (new writes waiting for acknowledgement)
- `auth.lockout`

Delivery is retried with backoff (3 attempts; 4xx other than 429 is not retried). Failures update `last_error`, shown on Settings → Notifications, and every channel has a Test button. Notification bodies are built from the **redacted** summary and never contain raw params.

### 9.2 Approval links

- For each pending approval and each channel, core issues link tokens: `approve`, `deny`, and `view`. A token is 256 random bits, stored hashed in `approval_links`, bound to `approval_id`, and expires with the approval.
- A link opens `https://mcp.example.com/a/{token}` on the **MCP port**. It never points at the admin port, which is typically LAN-only.
- **A link alone never decides an approval.** The page requires login: local password (+ TOTP) or OIDC, via the minimal MCP-port login and its short-lived `oauth_ui` session (never valid on the Admin API). The decision is a CSRF-protected POST, so opening or prefetching a link changes nothing. It then shows the full redacted approval (summary, params, targets, diff) and asks for confirmation. For a typed-confirmation operation it requires the literal. The token is marked `used` when the decision is recorded, and other tokens for the same approval are then invalid.
- This keeps the property that deciding an approval requires an authenticated human who has seen the call (TN §3.3). The link is only a shortcut to the right page.

---

## 10. Maintenance & Auto-Update (per instance)

TN §5, SR §5, and HA §5 apply unchanged, each run **per instance** by the core scheduler:

- **Session-start sync, debounced.** On a new MCP session to `/{slug}`: if `last_synced_at` is older than `syncMaxAge` (default 1 h), or if `getUpstreamVersion()` ≠ `upstream_version`, run `syncCatalog` (+ `syncRegistry`) **before** serving the session's first `search`/`execute`. An in-process per-instance mutex means concurrent session starts share one sync.
- **Group mapping on sync.** Each operation's `plugin_group` is mapped through `operation_group_aliases`. Missing groups are created at `read`. Groups with no remaining operations are marked `stale` (their level is kept in case they return). New writes arrive quarantined (§5.2.1).
- **Cron backstop.** Daily, per instance (staggered). Also available as the "Sync now" button / `POST /api/instances/:id/sync`.
- **Mid-session recheck.** Every 30 min for sessions still open, a cheap version comparison. On mismatch, a sync runs before the next call.
- **Registry freshness (HA).** `syncRegistry` runs on the same cadence, plus when the plugin sends `catalogChanged`. `resolveTargets` uses the plugin's live view, so area membership is evaluated as of call time (HA §5).
- **Sync failure.** Keep serving the last-synced catalog (fail open on _reading_ classifications), set `last_sync_status = error`, and notify `sync.failed`. If an instance has **no** prior sync and the upstream is unreachable, it stays in `error` and its endpoint returns 503 (TN §2.2 refuse-to-start, now per instance, not for the whole process).
- **Plugin repo index refresh.** Daily. Surfaces update availability and key changes. It never installs anything.
- **Housekeeping (hourly).** Purge `pre_approval_hits` older than the largest rule window. Purge expired sessions, OAuth codes, tokens, and approval links. Purge decided approvals older than 7 days; the audit log keeps their record. `audit_log` has **no** automatic purge; an optional `audit.retentionDays` setting (default unset = keep forever) exists for disk hygiene and is itself audited.

---

## 11. Deployment

- **One image**, multi-stage build:
  1. `pnpm install --frozen-lockfile`
  2. build SDK → core → admin-ui → core plugins
  3. runtime stage: `node:22-bookworm-slim` with the production `node_modules` (native: `better-sqlite3`, `isolated-vm`, `argon2`), `packages/core/dist`, the admin-ui `dist` (served by core), and `plugins/*/{manifest.json,dist}`
- Runs as a non-root user. `DATA_DIR=/data` is a volume. `EXPOSE 8080 8081`. `HEALTHCHECK` hits `:8080/healthz`.
- `/healthz` (both ports) returns `{status, db, plugins: {…instance: status}, pendingApprovals, lastSyncAgeSeconds}`. It is unauthenticated and contains no secrets or slugs; per-instance details are only on the admin port's `/api/overview`. On the MCP port it returns only an aggregate status.
- **Reverse proxy** (documented examples for Caddy, Traefik, and Cloudflare Tunnel):
  - `mcp.example.com` → `:8080`. Must pass `Mcp-Session-Id`, allow SSE (no buffering), and forward `X-Forwarded-Proto`/`Host`.
  - `admin.lan` (or a VPN-only hostname) → `:8081`. **Do not** publish it on the internet. If it must be remote, put it behind Cloudflare Access / Authelia in addition to the portal login.
  - `TRUST_PROXY=true` makes core honor `X-Forwarded-*` headers for client IP (rate limiting, audit), scheme, and cookie `Secure`.
- **Environment** (full list in `.env.example`): `DATA_DIR`, `MASTER_KEY`, `MCP_HOST`/`MCP_PORT`, `ADMIN_HOST`/`ADMIN_PORT`, `PUBLIC_MCP_URL`, `PUBLIC_ADMIN_URL`, `TRUST_PROXY`, `CORE_PLUGINS_AUTOENABLE`, `ADMIN_BOOTSTRAP_USERNAME`/`ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_FORCE_LOCAL_LOGIN`, `LOG_LEVEL`.
- **Egress hardening (recommended):** container network policy limiting outbound traffic to the upstream hosts, ntfy/webhook targets, OIDC issuer, and plugin repo hosts (see §4.4 limit).

---

## 12. Security Summary

| Boundary                 | Control                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Internet → admin         | Separate port, not proxied publicly (deployment), plus login + TOTP/OIDC, sessions, CSRF, lockout              |
| Internet → MCP endpoint  | Per-endpoint auth mode (§6.2), scoped tokens/grants, 403 outside scope                                         |
| MCP client → upstream    | Sandbox (only the binding is reachable) → gate (§5.2) → plugin `invoke`                                        |
| Model → config           | No MCP tool writes config; the sandbox has no DB access (TN §4)                                                |
| Plugin → core secrets/DB | Child process, permission model, scrubbed env, per-instance secrets only                                       |
| Plugin supply chain      | Pinned versions, sha256, optional pinned-key signatures, unsigned warnings, prebuilt only (no install scripts) |
| Approval integrity       | Params-hash-bound, single-use, typed confirmation, in-memory params (restart ⇒ deny), link pages require login |
| Secrets at rest          | AES-256-GCM, master key outside the DB, write-only APIs, redaction everywhere                                  |
| Audit                    | Append-only, covers calls, searches, config, auth, plugin events; never exposed to the model                   |

Residual risks, stated up front:

1. A malicious **installed** plugin can mislabel classifications or locked seeds for its own upstream, and can reach arbitrary network hosts. Mitigated by the trust flow (§4.3) and egress policy (§11), not by core.
2. `external` auth mode without JWT verification depends entirely on network placement.
3. SQLite single-writer: one core process. Scaling out would need Postgres. Out of scope.

---

## 13. Development Phases (TDD)

Same discipline as TN §7: tests first, phase gates, no loosening tests to pass. Coverage is tracked separately for the security-critical path (`gate/`, `auth/`, `plugins/host`, `crypto`).

| #   | Phase                                       | Tests first (highlights)                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | **Skeleton**                                | Both listeners boot; `/healthz` on each; cross-port 404; SDK manifest schema validates the 3 core manifests; admin login page renders                                                                                                                                                                                                                              |
| 1   | **Plugin SDK contracts**                    | Manifest schema edge cases (unknown widget rejected, slug/ID patterns, `sdk` range); RPC message types round-trip; `runPlugin` dispatches, maps errors to codes                                                                                                                                                                                                    |
| 2   | **Classification & group access (generic)** | `locked` > `override` > inferred; default-to-write; every branch of `reachable()` incl. missing group; new groups at `read`; new writes quarantined; read→write reclassification resets acknowledgement; aliases survive sync; merge takes the lower level; bulk Write rejects missing slug and stale preview and leaves locked ops off; locked API mutation → 409 |
| 3   | **DB, migrations, crypto**                  | AES-GCM round-trip; AAD binding (swapped rows fail); secrets never serialized by API DTOs; master-key bootstrap; rotation                                                                                                                                                                                                                                          |
| 4   | **Plugin host**                             | Spawn with permission flags (fs write denied, env scrubbed); IPC timeouts; crash → backoff restart; `PluginUnavailable` surfaced; disable → 503                                                                                                                                                                                                                    |
| 5   | **Plugin repos & install**                  | Index schema; sha256 mismatch rejected; signed repo: bad/missing signature rejected, key change blocks installs; unsigned requires confirm; core ID collision rejected                                                                                                                                                                                             |
| 6   | **Catalog sync**                            | Diff upsert, stale marking, locked seed disables existing rules, refuse-serve with no prior sync, version-mismatch forced sync, debounce mutex                                                                                                                                                                                                                     |
| 7   | **Sandbox**                                 | Only bindings reachable; `require`/`process`/`fetch` absent; infinite loop killed; memory cap; errors catchable in-sandbox; approval wait excluded from wall clock                                                                                                                                                                                                 |
| 8   | **Gate & pre-approval**                     | Pipeline order; attestation before access check; `OperationDisabled` carries the access reason; target resolution fail-closed; match evaluator operators; all-targets rule; missing field ⇒ no match; rate limit ⇒ human fallback; expiry; locked never pre-approved                                                                                               |
| 9   | **Approval service**                        | Elicitation/portal/link race — first wins; typed confirmation on every channel; params-hash single use; timeout ⇒ deny; restart ⇒ deny; no-path ⇒ deny                                                                                                                                                                                                             |
| 10  | **Admin auth**                              | Setup only when empty; argon2 verify; TOTP + recovery; lockout; session idle/absolute expiry; CSRF; OIDC allow policy, link-only when auto-provision off; break-glass rules                                                                                                                                                                                        |
| 11  | **MCP auth**                                | Each mode × scope matrix; 401 with RFC 9728 header; OAuth PKCE required; resource/audience binding; refresh rotation + reuse detection; DCR toggle; CF Access JWT verify                                                                                                                                                                                           |
| 12  | **Admin API**                               | Contract test per route; 409s; secret masking; config audit events with redacted diffs                                                                                                                                                                                                                                                                             |
| 13  | **Admin UI**                                | Component tests per page (per TN §7 phase 8 + HA registry-picker behavior + typed-confirm approve + login/TOTP/OIDC flows)                                                                                                                                                                                                                                         |
| 14  | **MCP endpoints**                           | Per-slug routing; tool descriptions templated per plugin; `search` excludes disabled by default; `execute` end-to-end against a fake plugin + fake elicitation client                                                                                                                                                                                              |
| 15  | **Notifications**                           | ntfy headers/actions; webhook signature; link tokens bound/expiring/single-use; link page requires login; no raw params in bodies                                                                                                                                                                                                                                  |
| 16  | **Maintenance jobs**                        | Mocked clock: debounce, cron stagger, mid-session recheck, housekeeping                                                                                                                                                                                                                                                                                            |
| 17  | **Plugin: TrueNAS**                         | TN §7 phases 1, 3 and TN §9 against a fake WS server, then staging                                                                                                                                                                                                                                                                                                 |
| 18  | **Plugin: Seerr**                           | SR §7 phases 1, 3, GET-as-action regression list, on-behalf-of key split, redaction of settings reads                                                                                                                                                                                                                                                              |
| 19  | **Plugin: Home Assistant**                  | HA §7 phases 1, 3, 4, 6, 7, garage-door key split, registry picker options                                                                                                                                                                                                                                                                                         |

**Progress** (updated as phases land):

| Phase                           | State       | Where                                                                                                                                                                                                      |
| ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Skeleton                      | done        | listeners, SPA shell, CI, Docker                                                                                                                                                                           |
| 1 Plugin SDK contracts          | done        | `plugin-sdk`: manifest schema (incl. `showWhen`/`connection.help`), RPC types, `runPlugin`, **`checkConformance()`** for plugin test suites                                                                |
| 2 Classification & group access | done        | `core/src/gate/access.ts`, `core/src/catalog/groups.ts`: levels, acknowledgement, bulk preview/apply with typed slug, merge/rename with aliases, exclude / locked opt-in / override                        |
| 3 DB, migrations, crypto        | done        | `core/src/db`, `core/src/crypto` (AES-256-GCM + AAD, HKDF subkeys, key file bootstrap, `rotate.ts` + `cli.js rotate-master-key`)                                                                           |
| 4 Plugin host                   | done        | `core/src/plugins`: discovery + registry upsert, `PluginProcess` (permission-confined fork, validated JSON-RPC, timeouts), `PluginSupervisor` (init, crash → backoff restart)                              |
| 5 Plugin repos & install        | done        | `core/src/plugins/repos.ts`, `minisign.ts` (verified against the reference `minisign` tool, `ED` and legacy `Ed`): full-key pinning, key-change block, checksum, safe extraction, atomic swap              |
| 6 Catalog sync                  | done        | `core/src/catalog/sync.ts` + `instances/manager.ts`: session-start sync when stale, version check, `catalogChanged` debounce, per-instance mutex, daily backstop; `registry.ts` mirror for `registry.find` |
| 7 Sandbox                       | done        | `core/src/sandbox`: fresh isolate per call, frozen bindings, JSON envelope, pausable budget, memory/result/log caps                                                                                        |
| 8 Gate & pre-approval           | done        | `core/src/gate/pipeline.ts` (+ `match`, `redact`, `preapproval`, `attestation`, `rate-limit`), `core/src/runtime` (`executeCode`, `searchCode` with `catalog.*`, `registry.find`, `guides.get`)            |
| 9 Approval service              | done        | `core/src/approvals/service.ts`: elicitation / portal / link race, timeout, typed confirmation, orphan denial at startup                                                                                   |
| 10 Admin auth                   | done        | `core/src/auth` (users, sessions, TOTP, throttle, OIDC) + `http/admin/auth.ts` (CSRF double-submit + Origin check)                                                                                         |
| 11 MCP auth                     | done        | `core/src/auth/mcp-auth.ts`, `mcp-tokens.ts`, `oauth.ts` (OAuth 2.1 AS: DCR, PKCE, RFC 8707 resources, refresh rotation with reuse detection) + `http/mcp/oauth-routes.ts`                                 |
| 12 Admin API                    | done        | `core/src/http/admin/*`                                                                                                                                                                                    |
| 13 Admin UI                     | done        | `packages/admin-ui`: every page in §8.2; component tests for login/TOTP/guards, Access (write dialog, stale list, bulk Write), SchemaForm, approvals; browser smoke test against a running server          |
| 14 MCP endpoints                | done        | `core/src/http/mcp/endpoint.ts`: `search`/`execute`, sessions bound to endpoint + principal, elicitation bridge; e2e with the real MCP SDK client                                                          |
| 15 Notifications                | done        | `core/src/notify`: ntfy (JSON publish, actions) and signed webhooks, retries; approval links → `http/mcp/approval-routes.ts` (sign-in + CSRF POST required, single use)                                    |
| 16 Maintenance jobs             | done        | `core/src/maintenance.ts` (hourly housekeeping, optional audit retention) + daily repo index refresh                                                                                                       |
| 17–19 Plugins                   | not started | scaffolds only in `plugins/*`                                                                                                                                                                              |

Plugins 17–19 can go in parallel once phase 14 is green. They are built against a shared **fake-plugin harness** that exercises the RPC contract without core, plus a **conformance test suite** exported from the SDK that every plugin (including third-party ones) can run.

---

## 14. Open Decisions

1. **Which plugin to build first** (phases 17–19). Suggested order: TrueNAS (the reference design, simplest classification) → Seerr → Home Assistant (widest capability use).
2. ~~**Seerr credential**~~ — **decided**: a dedicated local Seerr user with cookie sign-in by default, the global API key as the alternative (§3.4). Seerr has no service-account or per-user-key feature; verified against the `seerr-team/seerr` `develop` spec and auth middleware.
3. **Per-plugin network egress control** (§4.4). Options for a later iteration: route plugin egress through a core-owned HTTP proxy that enforces `network.hosts`, or run plugins in separate network namespaces. Not in v1.
4. **Audit retention default.** Currently "keep forever". Revisit if disk usage matters.

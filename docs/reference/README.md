# Self-Hosted MCP Servers — Design Package

Three design documents for search/execute (Code Mode) MCP servers with a permission gate, all following the same shared architecture, plus the chosen UI mockups referenced from them.

## Contents

```
design-docs/
  truenas-mcp-design.md          Full design doc for the TrueNAS MCP server
  seerr-mcp-design.md            Full design doc for the Seerr MCP server
  homeassistant-mcp-design.md    Full design doc for the Home Assistant MCP server

mockups/
  admin-portal/                  Admin Portal UI mockups (Connection, Methods,
                                  Pre-Approval Rules, Pending Approvals, Audit Log)
                                  referenced from all three design docs' Section 2.6/2.7
  ha-pre-approval-match-selector/
                                  The chosen entity/area/domain match-selector design
                                  (structured, dedicated pickers) for the HA server's
                                  Pre-Approval Rules form — design doc Section 2.4
```

## About the mockup files (`.dc.html`)

The files under `mockups/` are Claude "Design Component" source — the same format used by Claude's Design canvas artifacts. Each is a self-contained HTML file describing one screen/artboard, but it expects a small runtime (`support.js`) supplied by the artifact host; opening one directly as a static file in a browser will not render it correctly.

To view them as intended:
- Re-open the original published artifacts in Claude (the design docs link to them), or
- Paste a file's contents into a new Claude Design artifact to re-render it, or
- Treat the `.dc.html` markup/CSS as a visual reference when implementing the real Vue components for the Admin Portal — the inline styles, layout, and copy are a faithful spec for what to build, even without running the file itself.

`canvas.json` in each mockup folder is the layout index (artboard positions/sizes) from the original multi-artboard canvas; it's included for completeness but isn't needed to read the individual `.dc.html` files.

## Design docs: how they relate

All three servers share one architecture (Node/TS + FastMCP + `isolated-vm` sandbox, SQLite-backed Admin Portal with a Vue frontend, env-var basic-auth, enablement-toggle-first read-only default, MCP-elicitation-primary approval flow). Each doc is self-contained; where a decision is identical across servers, the later docs (Seerr, then Home Assistant) say so explicitly and point back to the TrueNAS doc's Section 2.6/4 for the full reasoning rather than repeating it.

The Home Assistant doc additionally documents four HA-specific decisions not needed by the other two servers: no raw `ws_command` escape hatch (2.2), surgical config-entry-flow edits with optimistic locking (2.8), replicating the source tool set's `BestPracticeKey` best-practice attestation as an independent gate precondition (3.6), and the entity/area/domain match-selector picker UI (2.4) — the one mocked here.

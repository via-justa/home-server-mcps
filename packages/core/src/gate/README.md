# gate/

Permission gate: resolveOperation → attestation → access (group level + per-op exclusions, locked
opt-in, write acknowledgement; `access.ts`) → target resolution → prepareWrite → classification →
pre-approval → human approval → invoke → redact → audit.

Design: `docs/design/unified-mcp-server.md` §5.2–§5.3, §5.5. Phases 2, 8 and 9 in §13.

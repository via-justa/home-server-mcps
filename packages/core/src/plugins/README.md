# plugins/

Plugin host: discovery (core `plugins/*` + `DATA_DIR/plugins`), manifest validation, repo index
fetch + sha256/signature verification, child-process spawn with the Node permission model, JSON-RPC
over IPC, crash supervision, catalog/registry sync.

Design: §3–§4, §10. Phases 4–6 in §13.

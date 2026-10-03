# {{name}} runbook

A manual checklist against a real {{name}} before a release.

1. Add an instance with a dedicated user; **Test connection** reports the version.
2. Sync: the catalog appears, and every group starts at the default level.
3. Run a read at Read. Check that secrets in its result show as `[REDACTED]`.
4. A write stays refused until its group is raised.
5. A locked operation asks for approval and requires the typed confirmation literal.
6. Check the audit log lists each call.

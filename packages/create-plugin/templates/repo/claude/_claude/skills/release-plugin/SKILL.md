---
name: release-plugin
description: Prepare a plugin release by bumping its version in manifest.json and package.json together, and optionally its minimum Synoikia version. Use when asked to release, publish, ship or bump the version of a plugin.
---

# Release a plugin

A release is a version bump merged to `main`; the Release workflow packs, signs, verifies and publishes every plugin whose version isn't in the published index yet (see `RELEASING.md`).

1. **Pick the version** with semver against the last release (`git log --oneline -- plugins/<id>`):
   - patch: fixes, catalog corrections, wording;
   - minor: new operations, connection fields or capabilities; also any `plugin.yaml` change that unlocks an operation, drops a `sensitiveParams`/`sensitiveResult` rule or overrides a classification to read (call it out in the PR);
   - major: a change that breaks existing instances, such as a renamed operation key or a removed connection field.
2. **Bump both files to the same version**: `plugins/<id>/manifest.json` and `plugins/<id>/package.json`.
3. **Minimum Synoikia version**, only when the change needs a newer core: `"synoikia": { "minCoreVersion": "x.y.z" }` in `package.json`. A newer SDK means bumping the manifest `sdk` range together with the `@synoikia/plugin-sdk` range, then `pnpm install`.
4. **Verify**: `pnpm --filter ./plugins/<id> test`, then `pnpm typecheck && pnpm lint && pnpm format:check`.

Released versions are immutable. Never touch `minisign.pub` or the signing steps of the workflow.

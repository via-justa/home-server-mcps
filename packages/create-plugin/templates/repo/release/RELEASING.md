# Releasing

This repository publishes a **signed plugin repository** that Synoikia installs from. Add it on Synoikia's Plugins → Repositories page as a signed repository:

- Index: `https://github.com/{{repository}}/releases/download/index/index.json`
- Public key: the key in `minisign.pub`

## One-time setup

1. Generate a password-less minisign key pair on a trusted machine: `minisign -G -W -p minisign.pub -s minisign.key`.
2. Commit `minisign.pub`. Store the whole `minisign.key` file (both lines) as the `MINISIGN_SECRET_KEY` Actions secret, then delete the local copy or keep it offline.
3. Check that `package.json` `synoikia.repository` is `{{repository}}`.

Never commit the secret key. Changing the key later makes every Synoikia install block this repository until its admin confirms the new key, so a new key is for a compromised key only.

## Releasing a plugin

Bump `version` in both the plugin's `manifest.json` and `package.json` (they must match) and merge to `main`. The Release workflow then:

1. runs every plugin's tests;
2. packs each plugin whose version isn't in the published index yet, as a deterministic tarball (`synoikia-plugin repo pack`);
3. signs each tarball and checks it against `minisign.pub`;
4. merges the new versions into the index (`repo index`);
5. installs each new version with Synoikia's own repository service, with `minisign.pub` pinned (`repo verify`);
6. only then creates the `<id>-v<version>` releases and replaces `index.json` on the `index` release (`repo publish`).

A released version is never changed: to ship a fix, bump the version again. A plugin can require a minimum Synoikia version with `"synoikia": { "minCoreVersion": "x.y.z" }` in its `package.json`.

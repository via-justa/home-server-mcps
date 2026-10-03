# @synoikia/create-plugin

Create [Synoikia](https://github.com/via-justa/synoikia-core) plugin repositories and plugins, then build, check and publish them. Guide: [`docs/plugin-authoring.md`](https://github.com/via-justa/synoikia-core/blob/main/docs/plugin-authoring.md).

```sh
pnpm create @synoikia/plugin my-plugins [--repository owner/name] [--release] [--claude]
```

Inside a plugin repository (a root devDependency; `pnpm new` maps to `synoikia-plugin new`):

| Command                                             | What                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `synoikia-plugin new`                               | Add a plugin: `--id --name --archetype --auth [--api-key-header] --yes`   |
| `synoikia-plugin build [dir]`                       | Bundle a plugin into `dist/index.js`, `plugin.yaml` validated and inlined |
| `synoikia-plugin check [dir…]`                      | Manifest, `plugin.yaml` and version checks                                |
| `synoikia-plugin repo pack\|index\|verify\|publish` | The signed plugin repository steps a release workflow runs                |

`@synoikia/create-plugin/vitest` exports `pluginFiles()`, the Vitest plugin that loads `.yaml` and `.md` imports as the bundle does.

Templates are plain files with `{{name}}` placeholders; nothing in a template runs. A smoke test scaffolds every archetype and runs its generated tests against the workspace SDK and core.

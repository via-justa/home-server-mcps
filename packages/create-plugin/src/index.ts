export { buildPlugin } from './build.js';
export type { BuildOptions } from './build.js';
export { checkPlugin } from './check.js';
export { loadYamlModule, moduleSource, parseYamlFile } from './files.js';
export { createRepoTool, repositoryFromRemote } from './repo.js';
export type { RepoOptions } from './repo.js';
export { findRepoRoot } from './repo-root.js';
export {
  ARCHETYPES,
  AUTH_KINDS,
  createRepo,
  fill,
  manifestFor,
  newPlugin,
  renderTemplate,
  validateId,
  validateNamespace,
} from './scaffold.js';
export type { Archetype, AuthKind, CreateRepoOptions, NewPluginOptions } from './scaffold.js';
export { pluginFiles } from './vitest.js';

import { moduleSource } from './files.js';

/**
 * Vite/Vitest plugin that loads `.yaml` and `.md` imports the way `synoikia-plugin build` bundles
 * them, so unit tests see exactly what the bundle does. Add it to the repository's `vitest.shared.ts`.
 */
export function pluginFiles() {
  return {
    name: 'synoikia-plugin-files',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?')[0]!;
      const source = moduleSource(file, file.endsWith('.md') ? code : undefined);
      return source === undefined ? undefined : { code: source, map: null };
    },
  };
}

import path from 'node:path';
import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import { moduleSource } from './files.js';

/**
 * Bundles a plugin into one self-contained `dist/index.js`: under the permission model the child can
 * read nothing outside its own package directory, so every dependency is inlined, and data files
 * (`plugin.yaml`, guides) are compiled in. The banner gives the ESM bundle a `require` for bundled
 * CommonJS (such as `ws`).
 */

export interface BuildOptions {
  /** The plugin package directory. */
  dir: string;
  entry?: string;
  outfile?: string;
  /** Extra export conditions, e.g. `synoikia-source` to bundle workspace sources in tests. */
  conditions?: string[];
  minify?: boolean;
}

const BANNER =
  "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

const dataFiles: Plugin = {
  name: 'synoikia-plugin-files',
  setup(b) {
    b.onLoad({ filter: /\.(ya?ml|md)$/ }, (args) => ({
      contents: moduleSource(args.path),
      loader: 'js',
      watchFiles: [args.path],
    }));
  },
};

export async function buildPlugin(opts: BuildOptions): Promise<string> {
  const outfile = path.resolve(opts.dir, opts.outfile ?? 'dist/index.js');
  await build({
    entryPoints: [path.resolve(opts.dir, opts.entry ?? 'src/index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
    banner: { js: BANNER },
    conditions: opts.conditions,
    minify: opts.minify ?? false,
    plugins: [dataFiles],
  });
  return outfile;
}

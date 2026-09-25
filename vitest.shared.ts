import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (the "source" export condition) so tests
// don't depend on a prior build. The rest mirrors Vite's default server conditions.
const conditions = ['source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: { include: ['test/**/*.test.ts'] },
});

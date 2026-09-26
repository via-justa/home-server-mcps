import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.ts';

// `pnpm test:coverage`: the security-critical modules must stay well covered (design §13).
const critical = { lines: 85, functions: 85, branches: 75, statements: 85 };

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        reporter: ['text-summary', 'html'],
        thresholds: {
          'src/gate/**': critical,
          'src/auth/**': critical,
          'src/approvals/**': critical,
          'src/sandbox/**': critical,
          'src/crypto/**': critical,
        },
      },
    },
  }),
);

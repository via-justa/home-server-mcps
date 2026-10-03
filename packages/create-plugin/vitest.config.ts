import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.ts';

// The smoke test scaffolds, builds and tests a plugin per template, running core's harness.
export default mergeConfig(shared, defineConfig({ test: { testTimeout: 180_000, hookTimeout: 180_000 } }));

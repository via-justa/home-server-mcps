import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'docs/mockups/**',
      'packages/core/drizzle/**',
      'packages/create-plugin/templates/**',
      'packages/create-plugin/.smoke/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
    // TypeScript (vue-tsc) already checks identifiers; no-undef doesn't know DOM globals in SFCs.
    rules: { 'no-undef': 'off' },
  },
  {
    // Plain-JS Node files (test fixture plugins run as-is, without a build step).
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', URL: 'readonly', setImmediate: 'readonly', console: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      // Template layout is Prettier's job; these rules fight its output.
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
    },
  },
);

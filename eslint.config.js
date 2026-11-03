import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**', 'deploy/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Scripts injected into web pages with page.evaluate.
    files: ['**/*.browser.js'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', CSS: 'readonly', getComputedStyle: 'readonly' },
    },
  },
);

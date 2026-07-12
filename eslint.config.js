import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'data'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The ToolDef handler contract and WebSocket glue use intentional `any`.
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow deliberately-unused args/vars when prefixed with `_`.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // Keep ESLint out of formatting — Prettier owns that.
  prettier,
);

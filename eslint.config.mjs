import importPlugin from 'eslint-plugin-import';
import prettierPlugin from 'eslint-plugin-prettier';
import securityPlugin from 'eslint-plugin-security';
import sonarjsPlugin from 'eslint-plugin-sonarjs';
import typescriptEslintPlugin from '@typescript-eslint/eslint-plugin';
import typescriptEslintParser from '@typescript-eslint/parser';

const eslintConfig = [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: typescriptEslintParser,
      parserOptions: {
        project: ['./tsconfig.json'],
      },
    },
    plugins: {
      import: importPlugin,
      security: securityPlugin,
      sonarjs: sonarjsPlugin,
      '@typescript-eslint': typescriptEslintPlugin,
      prettier: prettierPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['./tsconfig.json'],
          // Match tsconfig customConditions / tsx so #* maps to src/, not a stale dist/.
          conditionNames: ['@ya-risc-v/source', 'types', 'import', 'node', 'default'],
        },
        node: true,
      },
    },
    rules: {
      /** TypeScript type safety */
      '@typescript-eslint/no-explicit-any': 'error',
      /** Import rules */
      'import/no-unresolved': 'error',
      /** Single-export modules: default export (extra named exports e.g. helpers are OK). */
      'import/prefer-default-export': ['error', { target: 'single' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./*', '../*', '../**', './**'],
              message: 'Use # package imports (see package.json "imports"), not relative paths.',
            },
          ],
        },
      ],
      /** Security */
      /** Emulator code indexes typed arrays by instruction fields constantly; this rule is noise here. */
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-regexp': 'error',
      /** Code quality */
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-duplicate-string': 'error',
      'sonarjs/no-identical-functions': 'error',
      /** Type-aware unsafe operations */
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      /** Additional strict type safety */
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/ban-types': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      /** Code style */
      'prettier/prettier': 'error',
      eqeqeq: ['error', 'always'],
      'func-style': ['error', 'expression'],
      /** Bitwise ops are expected for instruction decode and register arithmetic. */
      'no-bitwise': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionExpression',
          message: 'Use arrow functions instead of function expressions.',
        },
        {
          selector: 'ExportDefaultDeclaration > FunctionDeclaration',
          message:
            'Do not use `export default function`; use a const (e.g. arrow) and `export default name` instead.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: {
      /** Table-driven tests repeat literals on purpose; extracting them hurts readability. */
      'sonarjs/no-duplicate-string': 'off',
      /** `node:test` `describe`/`it` return promises the runner awaits. */
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
];

export default eslintConfig;

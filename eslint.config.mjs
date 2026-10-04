import importPlugin from 'eslint-plugin-import';
import prettierPlugin from 'eslint-plugin-prettier';
import securityPlugin from 'eslint-plugin-security';
import sonarjsPlugin from 'eslint-plugin-sonarjs';
import typescriptEslintPlugin from '@typescript-eslint/eslint-plugin';
import typescriptEslintParser from '@typescript-eslint/parser';

/** Shared `#` / relative import shape (must be re-listed when a block replaces this rule). */
const importShapePatterns = [
  {
    group: ['./*', '../*', '../**', './**'],
    message: 'Use # package imports (see package.json "imports"), not relative paths.',
  },
  {
    group: ['#*.js', '#*/*.js', '#*/*/*.js', '#*/*/*/*.js'],
    message: 'Omit the file extension; #specifiers resolve like a bundler.',
  },
];

/**
 * Private siblings of packages that have an `index.ts`, plus emulator host types.
 * Public exceptions: `#emulator/.../run` worker entries (resolved via `import.meta.resolve`).
 * `#emulator/types` is private to `#emulator` (`index.ts` only).
 */
const allPackagePrivatePatterns = [
  {
    group: [
      '#emulator/uart/*',
      '#emulator/terminal/*',
      '#emulator/timer/*',
      '#emulator/cpu/*',
      '#emulator/clint/*',
      '#emulator/plic/*',
      '#emulator/types',
      '#tui/*',
    ],
    message:
      'Import from the package root only (worker #emulator/.../run entries are public subpaths).',
  },
];

/** Package-private patterns excluding one package's own `#pkg/*` siblings. */
const packagePrivateExcept = (ownGroup) =>
  allPackagePrivatePatterns.map((pattern) => ({
    ...pattern,
    group: pattern.group.filter((group) => group !== ownGroup),
  }));

/** Outside packages: full private surface. Tests may deep-import `#emulator/cpu/*` only. */
const outsidePackagePrivatePatterns = allPackagePrivatePatterns;

const testPackagePrivatePatterns = [
  {
    group: [
      '#emulator/uart/*',
      '#emulator/terminal/*',
      '#emulator/timer/*',
      '#emulator/clint/*',
      '#emulator/plic/*',
      '#emulator/types',
      '#tui/*',
    ],
    message: 'Tests may deep-import #emulator/cpu/*; other packages only via their roots.',
  },
];

const eslintConfig = [
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts'],
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
          patterns: [...importShapePatterns],
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
    /**
     * Outside package directories: import only each package's public root.
     * `emulator/index.ts` may import private `#emulator/types`.
     */
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts'],
    ignores: [
      'src/emulator/uart/**',
      'src/emulator/clint/**',
      'src/emulator/plic/**',
      'src/emulator/terminal/**',
      'src/emulator/timer/**',
      'src/emulator/cpu/**',
      'src/tui/**',
      'src/emulator/index.ts',
      'src/emulator/types.ts',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.integration.test.ts',
      'test/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...importShapePatterns, ...outsidePackagePrivatePatterns],
        },
      ],
    },
  },
  {
    /** Emulator host entry may import `#emulator/types`. */
    files: ['src/emulator/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...importShapePatterns,
            ...allPackagePrivatePatterns.map((pattern) => ({
              ...pattern,
              group: pattern.group.filter((group) => group !== '#emulator/types'),
            })),
          ],
        },
      ],
    },
  },
  {
    /** Tests may deep-import `#emulator/cpu/*`; other packages only via roots. */
    files: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.integration.test.ts',
      'test/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...importShapePatterns, ...testPackagePrivatePatterns],
        },
      ],
    },
  },
  {
    files: ['src/emulator/cpu/**/*.ts'],
    ignores: ['src/emulator/cpu/**/*.test.ts', 'src/emulator/cpu/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:worker_threads',
              importNames: ['Worker'],
              message:
                'Only the CPU host (cpu/index.ts) may spawn workers; hart code must not import Worker.',
            },
          ],
          patterns: [
            ...importShapePatterns,
            ...packagePrivateExcept('#emulator/cpu/*'),
            {
              group: [
                '#emulator/timer',
                '#emulator/timer/*',
                '#emulator/terminal',
                '#emulator/terminal/*',
              ],
              message:
                'Hart code uses #emulator/clint (device API); do not import #emulator/timer or #emulator/terminal.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/emulator/cpu/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...importShapePatterns, ...packagePrivateExcept('#emulator/cpu/*')],
        },
      ],
    },
  },
  {
    files: ['src/emulator/uart/**/*.ts'],
    ignores: ['src/emulator/uart/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...importShapePatterns, ...packagePrivateExcept('#emulator/uart/*')],
        },
      ],
    },
  },
  {
    files: ['src/emulator/clint/**/*.ts'],
    ignores: ['src/emulator/clint/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...importShapePatterns, ...packagePrivateExcept('#emulator/clint/*')],
        },
      ],
    },
  },
  {
    files: ['src/emulator/plic/**/*.ts'],
    ignores: ['src/emulator/plic/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...importShapePatterns, ...packagePrivateExcept('#emulator/plic/*')],
        },
      ],
    },
  },
  {
    files: ['src/emulator/timer/**/*.ts'],
    ignores: ['src/emulator/timer/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...importShapePatterns, ...packagePrivateExcept('#emulator/timer/*')],
        },
      ],
    },
  },
  {
    files: ['src/emulator/terminal/**/*.ts'],
    ignores: ['src/emulator/terminal/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...importShapePatterns, ...packagePrivateExcept('#emulator/terminal/*')],
        },
      ],
    },
  },
  {
    files: ['src/tui/**/*.ts', 'src/tui/**/*.tsx'],
    ignores: ['src/tui/**/*.test.ts', 'src/tui/**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...importShapePatterns, ...packagePrivateExcept('#tui/*')],
        },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      /** Table-driven tests repeat literals on purpose; extracting them hurts readability. */
      'sonarjs/no-duplicate-string': 'off',
      /** `node:test` `describe`/`it` return promises the runner awaits. */
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
];

export default eslintConfig;

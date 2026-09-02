/**
 * The lint gate (implementation plan, Phase 1: "CI (lint, typecheck, test,
 * dependency-cruiser, bundle-inspection job)").
 *
 * ## What this replaces
 *
 * Every one of the thirty-one packages carried `"lint": "echo 'lint: configured in
 * Phase 1.1'"`. `pnpm lint` therefore reported "31 successful" while running nothing at
 * all — the exact failure the testing posture names elsewhere in CLAUDE.md: *a gate that
 * did not run must never report green*. It was quoted as evidence in a status report,
 * which is how a hollow gate does real damage.
 *
 * ## Why these rules and not `recommended` wholesale
 *
 * TypeScript is already configured strictly here (`strict`, `noUncheckedIndexedAccess`,
 * `exactOptionalPropertyTypes`), and `pnpm typecheck` runs it across every package — so
 * the large half of what a linter usually catches is caught already, by a better tool.
 * What is left for ESLint is the class of mistake the compiler accepts:
 * a floating promise, a `catch` that discards, a `==`, an unused import.
 *
 * The set is deliberately small and every rule is an ERROR. A gate with thirty warnings
 * nobody clears is a gate that has been turned off slowly, and this project has already
 * had one turned off all at once.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      // Generated or vendored: linting it reports on code nobody here wrote.
      'infrastructure/database/migrations/**',
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        performance: 'readonly',
        globalThis: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        indexedDB: 'readonly',
        navigator: 'readonly',
        WebSocket: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        RequestInit: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        React: 'readonly',
        NodeJS: 'readonly',
      },
    },
    rules: {
      /**
       * An unused variable is usually a rename that half-happened. The underscore escape
       * is kept for the genuine cases — a destructure that drops a field on purpose, a
       * catch that does not care which error it caught.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` erases exactly the guarantees the strict compiler settings exist to give.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      /**
       * Logging goes through `@starlink/observability`, where redaction is applied
       * centrally — a bare `console.log` is how a customer's name reaches a log file
       * unredacted. The four places that legitimately write directly (a bootstrap
       * confirmation before a logger exists, the dev OTP sink) already carry a disable
       * comment; enabling the rule is what makes those comments mean something.
       */
      'no-console': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  {
    /**
     * Operator tools, where printing IS the output.
     *
     * `migrate.mjs`, `seed.mjs` and `no-skips.mjs` are run by a person at a terminal and
     * have no logger to route through — their whole contract is what they print. The
     * redaction argument that motivates `no-console` elsewhere does not apply: none of
     * them handles customer content.
     */
    files: ['**/scripts/**', 'infrastructure/guards/src/*.mjs', 'e2e/support/*.mjs'],
    rules: { 'no-console': 'off' },
  },

  {
    // `.cjs` config files are CommonJS by definition; `module` is not a stray global.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly' } },
  },

  {
    /**
     * Test files may reach for shapes production code may not.
     *
     * A test that proves a refusal has to be able to construct the invalid input the
     * refusal is about, and forcing it through a valid type would mean testing something
     * other than the thing under test.
     */
    files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // A test narrates what it is doing when it fails; that is its job.
      'no-console': 'off',
    },
  },
);

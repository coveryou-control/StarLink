import { defineConfig } from 'vitest/config';

export default defineConfig({
  /*
     The AUTOMATIC JSX runtime, the same one the application is built with.

     `tsconfig.json` says `"jsx": "preserve"` because Next does the transform itself.
     esbuild reads that, finds nothing it can use, and falls back to the CLASSIC runtime —
     `React.createElement` — against modules that import named hooks from 'react' and no
     default. A component only breaks when its JSX is evaluated, so a test that renders
     nothing is fine and one that merely IMPORTS a module with JSX at module scope dies on
     the import with "React is not defined". `format-bytes.test.ts` imports `formatBytes`
     from `attachment-picker.tsx`, whose menu entries hold their icons in a const array.

     A whole test file failing to collect does not move the test COUNT, which is how this
     sat in a run reported by its passing total. `no-skips.mjs` catches it; reading the
     numbers instead of the exit code does not.
  */
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
  },
});

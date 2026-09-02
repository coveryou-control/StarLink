/**
 * StarLink boundary law — ADR-002.
 *
 * These rules are not style preferences. They are what makes the adapter pattern
 * (STARLINK_INTEGRATION_CONTRACTS.md §1) a structural property rather than a promise:
 * if a domain package can import an adapter implementation, then "swap the adapter,
 * don't rewrite the domain" is a convention someone will forget.
 *
 * A violation FAILS THE BUILD.
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-must-not-import-adapters',
      comment:
        'packages/* may depend only on interfaces in shared-contracts. Importing an adapter ' +
        'implementation couples the domain to a provider and breaks Phase 9/10 cutover.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^adapters/' },
    },
    {
      name: 'domain-must-not-import-apps',
      comment: 'Dependency direction is apps -> packages. Never the reverse.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'adapters-must-not-import-adapters',
      comment:
        'Adapters are siblings behind interfaces. Cross-adapter imports create hidden ' +
        'provider coupling (e.g. routing silently depending on a consent implementation).',
      severity: 'error',
      from: { path: '^adapters/([^/]+)/' },
      to: {
        path: '^adapters/([^/]+)/',
        pathNot: ['^adapters/$1/'],
      },
    },
    {
      name: 'adapters-must-not-import-domain',
      comment:
        'An adapter implements a contract; it must not reach into domain internals. ' +
        'Shared types belong in shared-contracts.',
      severity: 'error',
      from: { path: '^adapters/' },
      to: {
        path: '^packages/',
        pathNot: '^packages/shared-contracts/',
      },
    },
    {
      name: 'adapters-must-not-import-apps',
      severity: 'error',
      from: { path: '^adapters/' },
      to: { path: '^apps/' },
    },
    {
      name: 'shared-contracts-is-a-leaf',
      comment:
        'shared-contracts is imported by everything, so it must depend on nothing in-repo ' +
        'except itself. A cycle here would make the contract layer unversionable.',
      severity: 'error',
      from: { path: '^packages/shared-contracts/' },
      to: {
        path: '^(packages|adapters|apps)/',
        pathNot: '^packages/shared-contracts/',
      },
    },
    {
      name: 'ai-must-not-reach-a-deciding-path',
      comment:
        'Part IV §57 and brief §36: AI output is "recommendation or derived interpretation, ' +
        'NOT business truth", and it never decides identity, consent, routing hard constraints, ' +
        'authorization, or payment/claim/policy state — "hard compliance, entitlement, payment, ' +
        'policy and case state remain deterministic authority". ' +
        'That rule is only as good as the thing enforcing it, and a review checklist is not a ' +
        'thing. An advisory becomes an authority the moment a deciding module can read one: ' +
        'nobody writes `if (ai.saysDeny)`, they write `if (confidence > 0.9)` in a routing ' +
        'branch, and it reads as reasonable. The import edge is the defect, so the import edge ' +
        'is what fails the build. ' +
        'ADR-022 makes the same argument for feature flags — "no flag may bypass an ' +
        'authorization, consent, or visibility invariant" — and the same rule covers both, ' +
        'because a flag read inside authz/ arrives through exactly this kind of edge. ' +
        'Legitimate use is the other direction: a controller asks for an advisory and shows it ' +
        'to a person, who decides.',
      severity: 'error',
      from: {
        path: [
          '^packages/conversation-domain/src/authz/',
          '^packages/routing/',
          '^packages/service-case/',
          '^adapters/consent/',
          '^adapters/iam/',
        ],
      },
      to: { path: '^packages/ai-assist/' },
    },
    {
      name: 'customer-web-must-not-import-employee-web',
      comment:
        'ADR-004 / doc §19.2: the customer bundle must not CONTAIN employee code. ' +
        'Runtime hiding is not a boundary. Verified additionally by bundle inspection in CI.',
      severity: 'error',
      from: { path: '^apps/customer-web/' },
      to: { path: '^apps/employee-web/' },
    },
    {
      name: 'no-cross-app-imports',
      comment:
        'Two apps importing each other is two deployables welded together. Code both need ' +
        'belongs in a package or in infrastructure/ — see infrastructure/outbox-relay, which ' +
        'exists precisely because this rule caught the gateway importing from the workers app.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: {
        path: '^apps/([^/]+)/',
        pathNot: ['^apps/$1/'],
      },
    },
    {
      name: 'web-must-not-import-server-code',
      comment:
        'A browser bundle that imports infrastructure/ or adapters/ ships database clients, ' +
        'SQL and provider credentials to every visitor. Next.js tree-shaking is not a security ' +
        'boundary: the import edge itself is the defect, whether or not the code survives the ' +
        'build. Frontends talk to the API over HTTP and share TYPES only.',
      severity: 'error',
      from: { path: '^apps/[^/]+-web/' },
      to: { path: '^(infrastructure|adapters)/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Cycles make module ownership ambiguous (doc §18.3).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        'An import that resolves to nothing is usually an undeclared workspace dependency — ' +
        'which is also how a boundary violation first appears, before someone "fixes" it by ' +
        'adding the dependency. Catch it at the first step.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '(^|/)tsconfig\\.json$',
          // Framework config read by the toolchain, never imported by source.
          '(^|/)(next|vitest|postcss|tailwind)\\.config\\.(js|cjs|mjs|ts)$',
          /*
             `public/` is served as static files, not imported.

             The service worker there is an ORPHAN by definition — the browser fetches it by
             URL and runs it in its own global scope, and a `public/` asset that something
             imported would be the actual mistake. It is still linted; see the
             public-assets block in eslint.config.mjs.
          */
          '(^|/)public/',
        ],
      },
      to: {},
    },
  ],
  options: {
    // `dist` is doNotFollow rather than exclude: a cross-boundary import resolves to the
    // target package's BUILT entry point, so excluding dist outright would hide exactly
    // the violation these rules exist to catch. We report the edge, we just don't
    // traverse into compiled output.
    doNotFollow: { path: '(node_modules|dist)' },
    // `next-env.d.ts` is GENERATED by Next on every build and points at type-only paths
    // inside the framework that enhanced-resolve cannot see. Excluding the generated
    // file is right; excluding the `.next` build output is not optional either.
    exclude: { path: '(\\.next|\\.turbo|(^|/)next-env\\.d\\.ts$)' },
    // Resolve pnpm's symlinks to their real workspace paths, so an import of
    // `@starlink/adapter-iam` is seen as `adapters/iam/...` and matches the rules above
    // rather than hiding behind a node_modules path.
    preserveSymlinks: false,
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
    },
    // NodeNext ESM requires source to import `./actions.js` while the file on disk is
    // `actions.ts`. TypeScript's own resolver understands that mapping; enhanced-resolve
    // alone does not, and every relative import would read as unresolvable.
    parser: 'tsc',
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};

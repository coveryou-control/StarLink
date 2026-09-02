/**
 * Customer surface build.
 *
 * ADR-004 / doc §19.2: a SEPARATE Next.js app from `employee-web`, not a route group.
 * The requirement is not that the customer bundle hides employee components — it is that
 * the bundle does not CONTAIN them. Two apps make that true by construction; one app with
 * conditional rendering makes it true only until someone imports the wrong thing, and the
 * failure is invisible in review because the code still works.
 *
 * The boundary law (`.dependency-cruiser.cjs`) enforces both halves: `customer-web` may
 * not import `employee-web`, and no `*-web` may import `infrastructure/` or `adapters/`.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  // The API is a separate origin; nothing is proxied through here, so the browser
  // sees exactly the CORS and cookie boundaries production will have.
  //
  // There is deliberately no `env:` map here. It used to carry the origins, which reads
  // as configuration but is not: `env` is inlined by DefinePlugin at BUILD time, so the
  // hostname was welded into the compiled bundle and the built artefact could only ever
  // talk to whatever host the build machine happened to have. §37.7 makes "configuration
  // injected per environment" an ARCHITECTURAL REQUIREMENT and proposes an artefact
  // "built once, promoted between environments"; a build-inlined origin cannot satisfy
  // both, and the failure is silent — a production surface quietly calling staging.
  //
  // The origins are now read on the server per request and written into the document by
  // `components/runtime-origins-script.tsx`. `NEXT_PUBLIC_` would not have helped: it
  // inlines at build time too, so it moves the prefix without fixing the problem.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // The customer surface is the one an attacker can reach without credentials,
          // so it declines framing outright rather than allow-listing origins.
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;

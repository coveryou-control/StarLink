/**
 * Employee surface build.
 *
 * ADR-004 / doc §19.2: this is its OWN Next.js app, not a route group inside a shared
 * one. The customer bundle must not merely hide employee components — it must not
 * contain them, and separate apps make that true by construction rather than by a
 * build-time import check that someone could relax.
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
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;

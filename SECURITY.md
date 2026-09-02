# Security

StarLink carries insurance conversations: policy and claims context, customer identity, and
internal notes that a customer must never see. Treat a defect in any of those as a security
defect, not a bug.

## Reporting a vulnerability

**Do not open a GitHub issue, and do not describe it in a pull request.** Both are readable
by everyone with repository access, which is a wider audience than the finding should have
while it is unfixed.

Report it through CoverYou's internal security channel, to the StarLink maintainers.

> **Maintainers:** replace this line with the internal security address or ticket queue.
> It is deliberately blank rather than guessed — a security contact that does not reach
> anybody is worse than an obvious gap.

Include what you did, what happened, and what you expected. If you have a reproduction,
send it privately; do not attach real customer data to it under any circumstances.

## What never enters this repository

- **Secrets of any kind.** No connection strings with real credentials, no session or
  cursor signing keys, no object-storage keys, no tokens. `.env` is git-ignored;
  `.env.example` is the template and holds only obviously-labelled development
  placeholders. A committed secret is a rotated secret, not a deleted one.
- **Real customer data.** Not in a fixture, not in a test, not in a screenshot attached to
  an issue. Test data is synthetic and the seeded dev accounts are named in `CLAUDE.md`.
- **Production configuration.** Production supplies configuration through the platform's
  secret store, and the application refuses to start on a shipped development default, on
  a secret below minimum length, or on a database outside the `starlink` namespace.

CI runs a secret scan on every push and pull request (`.github/workflows/secrets.yml`). It
is a backstop, not permission to be careless: it can only catch patterns it knows.

## Properties the build enforces

These are not review conventions. Each one fails the build when violated, which is what
makes them properties rather than intentions.

| Property | Enforced by |
| --- | --- |
| Authorization is evaluated before content is read, on every path | `decide()` and the authz matrix suite |
| A customer can never see an internal note; if visibility cannot be established, the send fails | Visibility tests, serialiser field-filtering as defence in depth |
| An unknown permission is denied, never treated as unrestricted | `packages/conversation-domain/authz` |
| Exactly one owner per customer conversation | A database exclusion constraint |
| The audit ledger is append-only | Role grants and a trigger |
| StarLink opens only the `starlink` namespace and only `identity`, `conversation`, `audit` | `infrastructure/database/src/guard.ts`, before the first connection |
| Every setting carries `SL_` with no fallback to another product's variables | `@starlink/guards` |
| A message is durable before it is delivered | Outbox relay and its tests |

If you are changing anything in that table, say so in the pull request in those words.

## Dependencies

Dependabot opens weekly pull requests for npm and GitHub Actions. Security updates are
merged ahead of feature work. A new runtime dependency needs a line in the pull request
saying what it replaces and why an existing package will not do — the smaller the tree, the
smaller the surface.

## Data residency

Production data sits in an AWS RDS instance in an India region. IRDAI's *Maintenance of
Insurance Records* Regulations require policy and claims records to be held in Indian data
centres. Development may use another provider (currently Neon); **production may not.** Any
change to where data is stored is a compliance decision, not an infrastructure one.

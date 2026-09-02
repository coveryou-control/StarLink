# Contributing to StarLink

The conventions live in [`CLAUDE.md`](CLAUDE.md) and they apply to people as well as to
assistants. This file is the shorter thing: how a change gets from a working tree into
`main`.

## Before you write anything

Read the thirteen rules in `CLAUDE.md` under "Rules that are not negotiable". They are
enforced by tests rather than by review, and **if a change requires breaking one, it is
the wrong change.** The two that catch people most often:

- Authorization is evaluated *before content is read*, on every path. `decide()` in
  `packages/conversation-domain/authz` is the boundary; serialiser field-filtering is
  defence in depth and never the boundary.
- Never invent a business value — SLA targets, working hours, categories, capacity. They
  are configuration entities awaiting sign-off, listed in `docs/STARLINK_OPEN_QUESTIONS.md`.

## The loop

```bash
pnpm install
pnpm build                    # workspace packages resolve through dist/
# ... change things ...
pnpm verify                   # every gate, in CI's order
```

`pnpm verify` takes a few minutes. While iterating, the fast subset is
`pnpm lint && pnpm typecheck && pnpm exec vitest run <path>`, but **the merge gate is
`pnpm verify`** and a green subset is not evidence.

## Branches and commits

- Branch off `main`. Never commit to `main` directly.
- One concern per branch. A rename and a behaviour change in the same diff cost the
  reviewer the ability to see either.
- Write the commit message for someone reading it in a year: what changed, and *why the
  previous behaviour was wrong*. "Fix bug" is not a message.

## Pull requests

The template asks four questions. They are the ones that have actually caught defects here:

1. **What breaks if this is wrong?** — if the answer touches visibility, ownership or the
   audit ledger, say so explicitly so the reviewer reads it in that mode.
2. **Which gate proves it?** — name the test. "Covered by existing tests" is not an answer;
   if no test fails without your change, the change is unproven.
3. **What did you verify by hand, and what could you not verify?** — an honest "Docker is
   unavailable on my machine, so the compose path is untested" is worth more than silence.
4. **Does this touch a document?** — `docs/` is the source of truth; code that contradicts
   it is a defect in one of the two, and the PR should say which.

## Tests

- **Never weaken a test to make it pass.** If a test fails because behaviour deliberately
  changed, update the assertion *and say in the diff why the new expectation is correct*.
  If it fails for any other reason, the code is wrong.
- **A gate that did not run must never report green.** Database spikes call `ctx.skip()`
  when no PostgreSQL is reachable and print what is consequently unproven; `test:verify`
  fails the run if anything skipped.
- Test files run one at a time (`fileParallelism: false`), set in three places, all
  load-bearing — see `CLAUDE.md`. `infrastructure/guards/src/test-serialisation.test.ts`
  fails the build if any of the three is removed.

## Adding a dependency

Ask first whether an adapter behind an existing interface would do. Rule 11 is that
upstream gaps get an adapter, not a second implementation of somebody else's system.

New runtime dependencies need a line in the PR saying what they replace and why the
standard library or an existing package will not do.

## Things that will fail the build

- A cross-boundary import (`pnpm boundaries`).
- A configuration variable without the `SL_` prefix, or with a fallback chain.
- Opening a database outside the `starlink` namespace, or a schema other than `identity`,
  `conversation`, `audit`.
- A second transition table, a second Customer Master, or a permanent user authority.

## Platform notes

On Windows, **never write `package.json` with PowerShell `Set-Content -Encoding utf8`** —
it emits a UTF-8 BOM and every import in that package then reports as unresolvable. Use
the editor, or `[System.IO.File]::WriteAllText` with `UTF8Encoding($false)`. The
`.editorconfig` in this repository sets `charset = utf-8` for the same reason.

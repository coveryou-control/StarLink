<!--
  Four questions, because each one has caught a real defect in this repository.
  Delete nothing; answer "n/a" where a section genuinely does not apply and say why.
-->

## What this changes

<!-- One paragraph. What the behaviour was, what it is now, and why the old one was wrong. -->

## What breaks if this is wrong

<!--
  Be specific. If the answer touches any of these, say so in these words so the reviewer
  reads the diff in that mode:
    - message visibility (a customer seeing an internal note)
    - authorization (`decide()`, the object check, an unknown permission)
    - conversation ownership (the one-owner constraint, reassignment)
    - the audit ledger
    - durability (a message delivered before it was durable)
    - configuration (the SL_ prefix, a fallback chain, the database namespace)
-->

## Which gate proves it

<!--
  Name the test file and case. "Covered by existing tests" is not an answer: if nothing
  fails without this change, the change is unproven and the reviewer should say so.

  If this is a change no test can hold — a copy change, a layout value — say that instead
  of naming a test that does not test it.
-->

## Verified by hand

<!--
  What you actually ran and looked at, and what you could NOT verify. An honest
  "no Docker on this machine, so the compose path is untested" is worth more than silence;
  a claim of "tested" that turns out to mean "it compiled" costs the next person a day.
-->

---

- [ ] `pnpm verify` passes locally (or CI is green and I have read the run)
- [ ] No test was weakened to make this pass; any changed assertion says why the new
      expectation is correct
- [ ] No secret, credential or real customer data is in the diff
- [ ] No business value was invented — SLA targets, working hours, categories, capacity
      are configuration awaiting sign-off (`docs/STARLINK_OPEN_QUESTIONS.md`)
- [ ] Documents in `docs/` still agree with the code, or the PR says which one is now wrong

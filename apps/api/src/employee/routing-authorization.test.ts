/**
 * A route that names a thing must authorize against THAT thing.
 *
 * ## Why a source check, when the behaviour is already tested
 *
 * `claim-authorization.test.ts` proves the routes that were wrong are now right. It cannot
 * prove that the NEXT route added will be. The original defect was not a mistake in a rule
 * — it was reaching for the wrong one of two similarly named helpers, four separate times,
 * in a file where the correct one was already in use five times over. That is a mistake
 * with a shape, and a shape can be checked.
 *
 * ## What "authorizes against it" means, and why this does not check for a name
 *
 * The first version of this file asserted that a handler mentions `mayActOn`. That is a
 * check for a spelling, and the spelling is not the property. Widening the scan from one
 * controller to the whole directory turned up four legitimate spellings of the same object
 * check:
 *
 *   * `mayActOn` in `conversations` and `routing` — load, then `decide()`;
 *   * `authorize` in `lifecycle` — the same thing, returning the DECISION rather than a
 *     boolean, because §21.4's actor is read off the basis;
 *   * an inline load-and-decide inside the read transaction in `messages`, so the state
 *     the surface renders is the state authorization saw;
 *   * delegation to `sendMessage`, which owns the check for every send path.
 *
 * A name check calls three of those four a violation, and the obvious repair — OR-ing the
 * other names in — is how a guard becomes a list you edit until it goes quiet. So the
 * approved set is DERIVED: a helper counts when its own body loads the conversation and
 * decides against what it loaded. A new helper with a new name passes for free; a helper
 * that merely looks like one does not, whatever it is called.
 *
 * ## The two holes found when it was widened
 *
 *   * `POST :conversationId/read` in `conversations.controller.ts` had no authorization of
 *     any kind — a 200 for a conversation the caller could not see and a 500 for one that
 *     did not exist, which is a conversation-id oracle in the one route nobody thought
 *     carried content.
 *   * `messages.controller.ts` declares `:conversationId` on its `@Controller` prefix and
 *     its handlers are bare `@Post()` / `@Get()`. The message send and read pair — the
 *     most sensitive routes in the product — matched no pattern the guard had, so it was
 *     scanning the surface while the centre of it was invisible.
 *
 * A guard that names one file is the same mistake as a fix that names one call site.
 *
 * ADR-016 promises a general version of this ("an operation with no declared permission
 * annotation fails CI") and it does not exist. This is the narrow version, covering the
 * surface where the failures actually happened.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');

/** Comments stripped: these files explain their defects in prose, at length. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const CONTROLLERS = readdirSync(here).filter((f) => f.endsWith('.controller.ts'));

/**
 * The controller-level path, which is where `messages` declares its `:conversationId`.
 *
 * Reading only the decorator on the method treats
 * `@Controller('…/:conversationId/messages') + @Post()` as a route that names nothing —
 * and that pair is the send path.
 */
const prefixOf = (code: string): string => /@Controller\('([^']*)'\)/.exec(code)?.[1] ?? '';

/**
 * Every private method, sliced from its signature to the next member at method indent.
 *
 * Used to work out which helpers really are object checks, rather than trusting the name.
 */
const PRIVATE = String.raw`\n  private (?:async )?(\w+)\(([\s\S]*?)(?=\n  (?:private |public |@)|\n\})`;

const helpersIn = (code: string): { name: string; body: string }[] =>
  [...code.matchAll(new RegExp(PRIVATE, 'g'))].map(([, name, body]) => ({
    name: String(name),
    body: String(body ?? ''),
  }));

/**
 * A real object check LOADS the conversation and decides against what it loaded.
 *
 * Both halves are required, and that is the whole point. `mayDo` — the deleted helper this
 * file exists because of — called `decide()` with a resource whose every field was a
 * literal, including the caller's own principal id in place of the conversation id. It
 * would satisfy "mentions decide()" perfectly.
 */
const LOADS = /loadForAuthorization|loadConversationForUpdate|loadForRead/;
const DECIDES = /\bdecide\s*\(/;
const isObjectCheck = (body: string): boolean => LOADS.test(body) && DECIDES.test(body);

/** The team equivalent: load the team, run the queue-scope decision against what loaded. */
const isTeamCheck = (body: string): boolean =>
  /loadTeam|teamFor|contextFor/.test(body) && /\bdecideForTeam\s*\(/.test(body);

/**
 * Checks that live in another module, named here because a source scan cannot follow a
 * call across a package boundary.
 *
 * Each is PROVED below by reading its own source and applying the same `isObjectCheck`
 * test the local helpers get — so an entry here is a pointer to a check, not an exemption
 * from one. Adding a name without a module that passes fails the suite.
 */
const DELEGATED = [
  {
    symbol: 'sendMessage',
    source: 'packages/messaging/src/send-message.ts',
    why:
      'The write path. §18.4 step 3 lives inside the use case so every surface that ' +
      'sends — employee, customer, and any future one — gets the same check.',
  },
] as const;

interface Handler {
  readonly file: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

/**
 * Each route handler, sliced from its decorator to the next one, with the controller
 * prefix folded into its path.
 *
 * Sliced rather than parsed because the property being checked is textual, and a real
 * parser would be a lot of machinery for a question a regex answers honestly. The path
 * argument is OPTIONAL in the pattern: `@Post()` is a route, and omitting it hid a whole
 * controller.
 */
const HANDLER = String.raw`@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)([\s\S]*?)(?=\n {2}@(?:Get|Post|Put|Patch|Delete)\(|\n {2}private |\n\})`;

const sliceHandlers = (source: string, file = '', prefix = ''): Handler[] =>
  [...source.matchAll(new RegExp(HANDLER, 'g'))].map(([, method, path, body]) => ({
    file,
    method: String(method).toUpperCase(),
    path: [prefix, String(path ?? '')].filter((part) => part !== '').join('/'),
    body: String(body ?? ''),
  }));

const sources = CONTROLLERS.map((file) => {
  const code = stripComments(readFileSync(join(here, file), 'utf8'));
  const helpers = helpersIn(code);
  return {
    file,
    code,
    /** Names in THIS file whose own body passes the object-check test. */
    checks: helpers.filter((h) => isObjectCheck(h.body)).map((h) => h.name),
    teamChecks: helpers.filter((h) => isTeamCheck(h.body)).map((h) => h.name),
    handlers: sliceHandlers(code, file, prefixOf(code)),
  };
});

const handlers = sources.flatMap((s) => s.handlers);

/**
 * The check must be CALLED and its answer must be USED.
 *
 * `mentions()` — which this replaces — tested only that the name appeared in the body, and
 * that is not the property either. Replacing
 *
 *     if (!(await this.mayActOn(…, 'conversation.read'))) return refuse();
 *
 * with
 *
 *     void (await this.mayActOn(…, 'conversation.read'));
 *
 * left the guard green while fully restoring the conversation-id oracle it was written to
 * close. The authorization ran, was answered, and was thrown away — and since
 * `POST :conversationId/read` has no behavioural test anywhere, this file was its only
 * guard.
 *
 * Two shapes count as using the answer, because both are in the tree and both are correct:
 * negating the call inline, and binding it to a name that is tested afterwards. A bare
 * call, or one bound to a name nothing reads, does not.
 */
const answerIsUsed = (body: string, name: string): boolean => {
  const call = String.raw`(?:this\.)?${name}\s*\(`;

  // `if (!(await this.mayActOn(…)))`
  if (new RegExp(String.raw`!\s*\(?\s*await\s+${call}`).test(body)) return true;

  // `const decision = await this.authorize(…)` … `if (decision === undefined)`
  const bound = new RegExp(String.raw`(?:const|let)\s+(\w+)\s*=\s*await\s+${call}`).exec(body);
  if (bound !== null) {
    const variable = bound[1]!;
    // More than one occurrence means it is referenced somewhere beyond its declaration.
    return (body.match(new RegExp(String.raw`\b${variable}\b`, 'g')) ?? []).length > 1;
  }

  return false;
};

const checksWith = (body: string, names: readonly string[]): boolean =>
  names.some((name) => new RegExp(String.raw`\b${name}\s*\(`).test(body) && answerIsUsed(body, name));

describe('employee controller authorization', () => {
  it('finds the controllers and handlers it claims to scan', () => {
    // Without this, a change to the decorators would empty the list and every assertion
    // below would pass over nothing at all.
    expect(CONTROLLERS.length, 'no employee controllers found').toBeGreaterThan(6);
    expect(handlers.length, 'no route handlers matched — the slicer is broken').toBeGreaterThan(
      20,
    );
    expect(handlers.some((h) => h.path.includes(':conversationId'))).toBe(true);
    expect(handlers.some((h) => h.path.includes(':teamId'))).toBe(true);

    /**
     * The specific blind spot, asserted by name so it cannot come back quietly: the send
     * path is a bare `@Post()` under a prefixed controller, and until the prefix was folded
     * in, it was not in this list at all.
     */
    const messages = handlers.filter((h) => h.file === 'messages.controller.ts');
    expect(messages.length, 'the message controller matched no handlers').toBe(8);
    /**
     * Named, not just counted. The count alone would be satisfied by four handlers that
     * are not these — and the bare `@Post()` send path is the specific one that went
     * missing before the controller prefix was folded in.
     */
    expect(messages.map((h) => `${h.method} ${h.path}`).sort()).toEqual([
      'DELETE v1/employee/conversations/:conversationId/messages/:messageId',
      'DELETE v1/employee/conversations/:conversationId/messages/:messageId/reactions',
      'GET v1/employee/conversations/:conversationId/messages',
      'GET v1/employee/conversations/:conversationId/messages/:messageId/info',
      'PATCH v1/employee/conversations/:conversationId/messages/:messageId',
      'POST v1/employee/conversations/:conversationId/messages',
      'POST v1/employee/conversations/:conversationId/messages/:messageId/forward',
      'POST v1/employee/conversations/:conversationId/messages/:messageId/reactions',
    ]);
    expect(
      messages.every((h) => h.path.includes(':conversationId')),
      'the controller prefix is not being folded into the handler path',
    ).toBe(true);
  });

  it('derives an object check in every controller that routes on a conversation', () => {
    /**
     * Anti-vacuity for the derivation itself. If `isObjectCheck` stopped matching, every
     * approved set would be empty and the assertion below would report every route in the
     * product as unauthorized — loud, and therefore safe. The reverse is the danger: a
     * predicate that matched everything would approve everything silently, which is what
     * this case exists to make impossible.
     */
    const routing = sources.filter((s) =>
      s.handlers.some((h) => h.path.includes(':conversationId')),
    );
    expect(routing.length, 'no controller routes on a conversation — the slicer is broken')
      .toBeGreaterThan(2);

    const noCheck = routing
      .filter((s) => s.checks.length === 0 && !isObjectCheck(s.code))
      .map((s) => s.file);
    expect(
      noCheck,
      'these route on a conversation and contain no object check at all:\n' + noCheck.join('\n'),
    ).toEqual([]);
  });

  it('proves every delegated check really is one', () => {
    /**
     * The allowlist is a pointer, not a pass. Each named module is read and put through the
     * same predicate a local helper faces, so "authorization happens over there" stays a
     * claim this file can falsify.
     */
    for (const { symbol, source } of DELEGATED) {
      /**
       * Comments stripped, for the reason the local scan strips them: `send-message.ts`
       * mentions `decide()` in three separate prose comments, so an unstripped body
       * satisfies the DECIDES half of the predicate whatever the code does. The entry
       * would then be the exemption this docblock says it is not.
       */
      const body = stripComments(readFileSync(join(REPO_ROOT, source), 'utf8'));
      expect(
        isObjectCheck(body),
        `${symbol} is trusted to authorize by ${source}, and that file does not load a ` +
          'conversation and decide against it. Either it stopped checking, or this entry ' +
          'points at the wrong module.',
      ).toBe(true);
    }
  });

  it('object-checks every route that names a conversation', () => {
    const approved = (h: Handler): readonly string[] => [
      ...(sources.find((s) => s.file === h.file)?.checks ?? []),
      ...DELEGATED.map((d) => d.symbol),
    ];

    const unchecked = handlers
      .filter((h) => h.path.includes(':conversationId'))
      // Either it calls something proved to object-check, or it loads and decides inline.
      .filter((h) => !checksWith(h.body, approved(h)) && !isObjectCheck(h.body))
      .map((h) => `${h.file}: ${h.method} ${h.path}`);

    expect(
      unchecked,
      'these name a conversation in their own path and never authorize against it:\n' +
        unchecked.join('\n'),
    ).toEqual([]);
  });

  it('team-checks every route that names a team', () => {
    /**
     * The queue reads. Both were gated on a permission the caller held *somewhere*, with
     * the `:teamId` in the path never compared to anything — so the check passed for every
     * team in the company.
     */
    const unchecked = handlers
      .filter((h) => h.path.includes(':teamId'))
      .filter((h) => {
        const approved = sources.find((s) => s.file === h.file)?.teamChecks ?? [];
        return !checksWith(h.body, approved) && !isTeamCheck(h.body);
      })
      .map((h) => `${h.file}: ${h.method} ${h.path}`);

    expect(
      unchecked,
      'these name a team in their own path and never authorize against it:\n' +
        unchecked.join('\n'),
    ).toEqual([]);
  });

  it('has no permission-only check left to reach for', () => {
    /**
     * `mayDo` is gone from every controller. Asserted as staying gone rather than merely
     * unused, because an unused helper with a plausible name is an invitation — and the
     * reason all four of its call sites were wrong is that it looked like the easy option.
     */
    const present = sources.filter((s) => /\bmayDo\s*\(/.test(s.code)).map((s) => s.file);
    expect(
      present,
      'mayDo is back in:\n' +
        present.join('\n') +
        '\nIt authorizes against a resource made of literals; load the conversation and ' +
        'decide against what you loaded.',
    ).toEqual([]);
  });

  it('builds no synthetic resource anywhere', () => {
    /**
     * The exact fabrication, as it was written: `conversationId: principalId`. A resource
     * whose id is the caller is not a resource, and `scopeCovers` cannot evaluate a TEAM or
     * DEPARTMENT grant against one — which is why the fixtures that hid this defect all had
     * to grant GLOBAL.
     */
    const fabricating = sources
      .filter((s) => /conversationId:\s*principalId/.test(s.code))
      .map((s) => s.file);
    expect(
      fabricating,
      'a decision is being made against an invented conversation id in:\n' +
        fabricating.join('\n'),
    ).toEqual([]);
  });

  it('recognises the violations it is looking for', () => {
    /**
     * Positive controls, run through the SAME helpers the assertions above use and against
     * the text that actually shipped. Closing brace at column 0 included: it is what the
     * lookahead terminates on, so a sample without it would prove the regex works on a
     * shape that never occurs in a real file.
     */
    const wasBroken = `
  @Post('conversations/:conversationId/claim')
  async claim() {
    if (!(await this.mayDo(session.principalId, 'conversation.claim'))) return refuse();
  }

  @Get('queues/:teamId')
  async queue() {
    if (!(await this.mayDo(session.principalId, 'queue.read'))) return refuse();
  }
}
`;
    const sliced = sliceHandlers(wasBroken);
    expect(sliced.length, 'the slicer must match the shape that shipped').toBe(2);
    expect(sliced.filter((h) => !isObjectCheck(h.body))).toHaveLength(2);
    expect(sliced.filter((h) => !isTeamCheck(h.body))).toHaveLength(2);
    expect(/\bmayDo\s*\(/.test(wasBroken)).toBe(true);
    expect(/conversationId:\s*principalId/.test('conversationId: principalId,')).toBe(true);

    /**
     * The second blind spot: a bare decorator under a prefixed controller. Without the
     * prefix this route names nothing, and every assertion above skips it in silence.
     */
    const bare = `
@Controller('v1/employee/conversations/:conversationId/messages')
export class C {
  @Post()
  async send() {
    return this.store.write();
  }
}
`;
    const sliceBare = sliceHandlers(stripComments(bare), 'x.ts', prefixOf(bare));
    expect(sliceBare.length, 'a bare @Post() is a route').toBe(1);
    expect(sliceBare[0]!.path).toContain(':conversationId');
    expect(isObjectCheck(sliceBare[0]!.body), 'and it is unauthorized').toBe(false);

    /**
     * `mayDo` as it really was: a `decide()` over invented literals. The LOAD half of
     * `isObjectCheck` is the half that rejects it, and this is the control for that half —
     * without it, a predicate weakened to "mentions decide()" would still pass every case
     * in this file.
     */
    const fabricated = `
    const decision = decide({
      actor,
      action,
      resource: { conversationId: principalId, sensitivity: 'ORDINARY' },
      now,
    });
`;
    expect(DECIDES.test(fabricated), 'it does call decide()').toBe(true);
    expect(isObjectCheck(fabricated), 'and it still is not an object check').toBe(false);

    /**
     * And the helper slicer, whose output decides which names are approved. If it stopped
     * matching, `checks` would empty everywhere and this file would fail loudly rather than
     * quietly — but a helper slicer that matched the WRONG span could approve a name whose
     * body checks nothing, so both halves are pinned here.
     */
    const withHelpers = `
class C {
  @Get()
  async read() {}

  private async mayActOn(a: string): Promise<boolean> {
    const resource = await this.authz.loadForAuthorization(a);
    return decide({ resource }).allow;
  }

  private async mayDo(a: string): Promise<boolean> {
    return decide({ resource: { conversationId: a } }).allow;
  }
}
`;
    const found = helpersIn(withHelpers);
    expect(found.map((h) => h.name)).toEqual(['mayActOn', 'mayDo']);
    expect(found.filter((h) => isObjectCheck(h.body)).map((h) => h.name)).toEqual(['mayActOn']);
  });
});

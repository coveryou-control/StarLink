/**
 * The channel authorization matrix.
 *
 * A channel states three things independently — who may SEE it, who may READ it, who may
 * POST in it — so the interesting rows are the combinations, not the happy path. Almost
 * every test here is a refusal.
 *
 * The two properties this file exists to hold:
 *
 *   1. **Content is reachable by the policy, or by a time-boxed grant, and by nothing
 *      else.** Not by a GLOBAL role grant, which is what every seeder issues and what the
 *      admin API offers first. Rung 6a records the same finding for private threads,
 *      confirmed against the running system on 2026-09-08; a channel is where it would
 *      have been reintroduced.
 *
 *   2. **A missing policy denies.** The loader reads `conversation.channels` beside the
 *      conversation. If some future path forgets, every channel in the product must go
 *      dark rather than open — the failure has to be the loud one.
 */
import { describe, expect, it } from 'vitest';
import type { ChannelAccessPolicy } from '@starlink/shared-contracts';

import { decide, type ActorContext, type ResourceContext } from './decide.js';

const NOW = '2026-09-09T10:00:00.000Z';
const PAST = '2026-08-01T00:00:00.000Z';
const FUTURE = '2026-12-31T00:00:00.000Z';

const CHANNEL = 'conv-channel-1';

const employee = (over: Partial<ActorContext> = {}): ActorContext => ({
  principalId: 'emp-1',
  kind: 'EMPLOYEE',
  status: 'ACTIVE',
  teams: ['platform'],
  departments: ['technology'],
  grants: [],
  delegations: [],
  temporaryGrants: [],
  ...over,
});

/**
 * An employee holding every content permission at GLOBAL scope.
 *
 * This actor is the whole point of the suite. A seeded AGENT looks like this, and if a
 * channel ever falls through to rung 8 they read and post everywhere.
 */
const globallyGrantedAgent = (): ActorContext =>
  employee({
    grants: [
      {
        role: 'AGENT',
        actions: [
          'conversation.read',
          'conversation.message.send',
          'conversation.note.internal',
          'conversation.attachment.upload',
          'conversation.attachment.download',
          'conversation.message.react',
          'case.read',
        ],
        scopeKind: 'GLOBAL',
        effectiveFrom: PAST,
      },
    ],
  });

const policy = (over: Partial<ChannelAccessPolicy> = {}): ChannelAccessPolicy => ({
  visibility: 'EVERYONE',
  readAccess: 'ANYONE_WHO_CAN_SEE',
  postAccess: 'ANYONE_WHO_CAN_READ',
  archived: false,
  ...over,
});

/**
 * A channel resource. No case, no owner, no owning team — the omissions are the fixture,
 * exactly as in `decide.test.ts`'s private thread.
 */
const channel = (
  options: {
    readonly policy?: Partial<ChannelAccessPolicy>;
    readonly visibleToActor?: boolean;
    /** Absent means "not a member". */
    readonly memberRole?: string;
    /** Set to false to model a membership that has been dated out. */
    readonly memberIsLive?: boolean;
    /** Omits `channel` entirely — the loader-forgot case. */
    readonly withoutPolicy?: boolean;
  } = {},
): ResourceContext => ({
  conversationId: CHANNEL,
  conversationType: 'INTERNAL_CHANNEL',
  sensitivity: 'ORDINARY',
  ...(options.memberRole !== undefined
    ? {
        participant: {
          role: options.memberRole,
          replyAuthority: false,
          effectiveFrom: PAST,
          ...(options.memberIsLive === false ? { effectiveTo: '2026-09-01T00:00:00.000Z' } : {}),
        },
      }
    : {}),
  ...(options.withoutPolicy === true
    ? {}
    : {
        channel: {
          policy: policy(options.policy ?? {}),
          visibleToActor: options.visibleToActor ?? true,
        },
      }),
});

const may = (action: string, resource: ResourceContext, actor: ActorContext = employee()): boolean =>
  decide({ actor, action, resource, now: NOW }).allow;

const why = (action: string, resource: ResourceContext, actor: ActorContext = employee()): string => {
  const d = decide({ actor, action, resource, now: NOW });
  return d.allow ? `ALLOWED (${d.basis})` : d.reason;
};

// ---------------------------------------------------------------------------------------

describe('a channel with no policy attached is closed', () => {
  it('denies a read even to a member', () => {
    /* The loader forgot. That is a bug, and the safe rendering of a bug in an authorization
       input is a refusal — never the fallback nobody reviews. */
    expect(why('conversation.read', channel({ withoutPolicy: true, memberRole: 'PARTICIPANT' }))).toBe(
      'CHANNEL_POLICY_DENIES',
    );
  });

  it('denies a read to somebody holding every permission at GLOBAL scope', () => {
    expect(
      may('conversation.read', channel({ withoutPolicy: true }), globallyGrantedAgent()),
    ).toBe(false);
  });
});

describe('who can SEE it', () => {
  it('lets an employee inside the audience read an open channel without joining it', () => {
    /*
       The case that needs its own rung. `PARTICIPANT_ACTIONS` cannot reach a non-participant
       however it is narrowed, and a channel you can find but not read until you have joined
       is a channel you join blind.
    */
    const d = decide({
      actor: employee(),
      action: 'conversation.read',
      resource: channel({ visibleToActor: true }),
      now: NOW,
    });
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.basis).toBe('CHANNEL_POLICY');
  });

  it('refuses somebody outside the audience, even though the channel is open to those in it', () => {
    expect(why('conversation.read', channel({ visibleToActor: false }))).toBe('CHANNEL_POLICY_DENIES');
  });

  it('never locks a member out of their own channel, whatever the audience table says', () => {
    /*
       Defence against a narrow loader. `visibleToActor` is computed from departments, teams
       and named principals; somebody added to a DEPARTMENTS channel by hand matches none of
       them. Being in the room is knowing it exists.
    */
    expect(
      may(
        'conversation.read',
        channel({ visibleToActor: false, memberRole: 'PARTICIPANT', policy: { visibility: 'SELECTED' } }),
      ),
    ).toBe(true);
  });
});

describe('who can READ it', () => {
  const closed = { readAccess: 'MEMBERS' } as const;

  it('lets a member read', () => {
    expect(may('conversation.read', channel({ policy: closed, memberRole: 'PARTICIPANT' }))).toBe(true);
  });

  it('refuses a non-member who can see it', () => {
    /* Visible and closed at the same time — the combination that makes joining something a
       person can ask for rather than guess at. */
    expect(why('conversation.read', channel({ policy: closed, visibleToActor: true }))).toBe(
      'CHANNEL_POLICY_DENIES',
    );
  });

  it('refuses a former member whose participation was dated out', () => {
    /* BR-09/§24.3: participation is ended, never deleted. An ended row must not read. */
    expect(
      may(
        'conversation.read',
        channel({ policy: closed, memberRole: 'PARTICIPANT', memberIsLive: false }),
      ),
    ).toBe(false);
  });

  it('refuses a non-member holding conversation.read at GLOBAL scope', () => {
    /* THE test. Every seeded employee is this actor. */
    expect(
      why('conversation.read', channel({ policy: closed }), globallyGrantedAgent()),
    ).toBe('CHANNEL_POLICY_DENIES');
  });

  it('refuses the attachment download too, not just the message read', () => {
    /* Otherwise the files in a private channel are readable by id while the messages are
       not, which is the same leak wearing a different route. */
    expect(
      may('conversation.attachment.download', channel({ policy: closed }), globallyGrantedAgent()),
    ).toBe(false);
  });
});

describe('who can POST in it', () => {
  it('lets anyone who can read post in a discussion channel', () => {
    expect(may('conversation.message.send', channel({ visibleToActor: true }))).toBe(true);
  });

  it('refuses a reader who is not a member when posting is members-only', () => {
    expect(
      why('conversation.message.send', channel({ policy: { postAccess: 'MEMBERS' } })),
    ).toBe('CHANNEL_POLICY_DENIES');
  });

  it('still lets that reader read', () => {
    /* Read wider than write is the arrangement the brief asks for, so the two have to come
       apart cleanly rather than one dragging the other. */
    expect(may('conversation.read', channel({ policy: { postAccess: 'MEMBERS' } }))).toBe(true);
  });

  it('refuses an ordinary member when posting is reserved to administrators', () => {
    /*
       Why the channel rung sits BEFORE participation. `PARTICIPANT_ACTIONS` contains
       `conversation.message.send`, so rung 5 would have handed this member the room.
    */
    expect(
      why(
        'conversation.message.send',
        channel({ policy: { postAccess: 'ADMINS' }, memberRole: 'PARTICIPANT' }),
      ),
    ).toBe('CHANNEL_POLICY_DENIES');
  });

  it.each(['CREATOR', 'ADMIN'])('lets a %s post there', (role) => {
    /* Two spellings, one predicate. CREATOR is history, ADMIN is authority given later, and
       a department room outlives the person who opened it. */
    expect(
      may('conversation.message.send', channel({ policy: { postAccess: 'ADMINS' }, memberRole: role })),
    ).toBe(true);
  });

  it('refuses an internal note from somebody who may not post', () => {
    /* A note is a message with a visibility, not a way around the posting rule. */
    expect(
      may(
        'conversation.note.internal',
        channel({ policy: { postAccess: 'ADMINS' }, memberRole: 'PARTICIPANT' }),
      ),
    ).toBe(false);
  });

  it('refuses an attachment upload from somebody who may not post', () => {
    expect(
      may(
        'conversation.attachment.upload',
        channel({ policy: { postAccess: 'ADMINS' }, memberRole: 'PARTICIPANT' }),
      ),
    ).toBe(false);
  });

  it('refuses a non-member holding conversation.message.send at GLOBAL scope', () => {
    expect(
      may('conversation.message.send', channel({ policy: { postAccess: 'MEMBERS' } }), globallyGrantedAgent()),
    ).toBe(false);
  });
});

describe('reacting is a reader act', () => {
  it('lets a reader who may not post react', () => {
    /* The same call the announcement makes: acknowledging is not contributing, and a notice
       board whose audience may not respond at all is the worse product. */
    expect(
      may('conversation.message.react', channel({ policy: { postAccess: 'ADMINS' }, memberRole: 'PARTICIPANT' })),
    ).toBe(true);
  });

  it('refuses somebody who may not read', () => {
    expect(
      may('conversation.message.react', channel({ policy: { readAccess: 'MEMBERS' } })),
    ).toBe(false);
  });
});

describe('an archived channel accepts nothing new', () => {
  const retired = { archived: true } as const;

  it('still reads, because the history is the point of keeping it', () => {
    expect(may('conversation.read', channel({ policy: retired, memberRole: 'PARTICIPANT' }))).toBe(true);
  });

  it('refuses a post from a member', () => {
    expect(may('conversation.message.send', channel({ policy: retired, memberRole: 'PARTICIPANT' }))).toBe(
      false,
    );
  });

  it('refuses a post from an administrator', () => {
    expect(may('conversation.message.send', channel({ policy: retired, memberRole: 'ADMIN' }))).toBe(false);
  });

  it('refuses a reaction', () => {
    expect(may('conversation.message.react', channel({ policy: retired, memberRole: 'ADMIN' }))).toBe(false);
  });
});

describe('administering a channel is not reading it', () => {
  it('lets the channel own administrator manage membership', () => {
    expect(may('conversation.participant.add', channel({ memberRole: 'ADMIN' }))).toBe(true);
  });

  it('refuses an ordinary member managing membership', () => {
    /*
       BR-05 gives any participant of an internal GROUP the membership, and that must not
       leak here: a group is four people who each let the next one in, and a channel is a
       department space with a stated access policy.
    */
    expect(may('conversation.participant.add', channel({ memberRole: 'PARTICIPANT' }))).toBe(false);
  });

  it('lets a holder of channel.manage repair a channel they are not in', () => {
    /* Somebody has to be able to fix the audience of a room whose last administrator left. */
    const custodian = employee({
      grants: [
        { role: 'ADMIN', actions: ['channel.manage'], scopeKind: 'GLOBAL', effectiveFrom: PAST },
      ],
    });
    expect(may('channel.manage', channel({ policy: { readAccess: 'MEMBERS' } }), custodian)).toBe(true);
  });

  it('and that custodian still cannot read the messages', () => {
    /*
       FR-AUTHZ-7 and `decide()`'s own property 5: administration confers no read. The
       custodian joins the channel or takes a temporary grant, and both of those are visible.
    */
    const custodian = employee({
      grants: [
        {
          role: 'ADMIN',
          actions: ['channel.manage', 'conversation.read'],
          scopeKind: 'GLOBAL',
          effectiveFrom: PAST,
        },
      ],
    });
    expect(why('conversation.read', channel({ policy: { readAccess: 'MEMBERS' } }), custodian)).toBe(
      'CHANNEL_POLICY_DENIES',
    );
  });
});

describe('the lawful way into a private channel', () => {
  it('honours a temporary grant naming this conversation', () => {
    /*
       Explicit, time-boxed, names the conversation, audited on success and on refusal. If
       this did not work there would be no lawful route into a private room for a compliance
       investigation, and the pressure would go somewhere worse.
    */
    const investigator = employee({
      temporaryGrants: [
        {
          grantId: 'tg-1',
          capability: 'conversation.read',
          conversationId: CHANNEL,
          effectiveFrom: PAST,
          effectiveTo: FUTURE,
        },
      ],
    });
    const d = decide({
      actor: investigator,
      action: 'conversation.read',
      resource: channel({ policy: { readAccess: 'MEMBERS' }, visibleToActor: false }),
      now: NOW,
    });
    expect(d.allow).toBe(true);
    expect(d.allow === true && d.basis).toBe('TEMPORARY_GRANT');
  });

  it('refuses one that has expired', () => {
    const investigator = employee({
      temporaryGrants: [
        {
          grantId: 'tg-1',
          capability: 'conversation.read',
          conversationId: CHANNEL,
          effectiveFrom: PAST,
          effectiveTo: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
    expect(may('conversation.read', channel({ policy: { readAccess: 'MEMBERS' } }), investigator)).toBe(
      false,
    );
  });

  it('refuses one issued for a different conversation', () => {
    const investigator = employee({
      temporaryGrants: [
        {
          grantId: 'tg-1',
          capability: 'conversation.read',
          conversationId: 'some-other-conversation',
          effectiveFrom: PAST,
          effectiveTo: FUTURE,
        },
      ],
    });
    expect(may('conversation.read', channel({ policy: { readAccess: 'MEMBERS' } }), investigator)).toBe(
      false,
    );
  });
});

describe('a channel is not a customer conversation', () => {
  it('denies a customer principal outright', () => {
    /* Denied by KIND before anything else is considered (§27.16). A channel is internal
       furniture and there is no arrangement of its policy that should reach a customer. */
    const customer = employee({ kind: 'CUSTOMER', assurance: 'AUTHENTICATED_CUSTOMER' });
    expect(may('conversation.read', channel({ memberRole: 'PARTICIPANT' }), customer)).toBe(false);
  });

  it('denies an employee who has left, however open the channel', () => {
    expect(may('conversation.read', channel(), employee({ status: 'EXITED' }))).toBe(false);
  });
});

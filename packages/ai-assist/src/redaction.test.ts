/**
 * The redaction boundary, tested as a LEAK property rather than as a feature.
 *
 * These assertions are written the way `customer-projection.test.ts` writes its: plant
 * sentinels in the input, search the whole serialised output for any that survived. A
 * test that checks "the summary excludes internal notes" passes on an implementation that
 * excludes them by accident and stops excluding them when someone adds a field. A test
 * that searches the output for the note's text does not.
 *
 * The direction matters here more than most places, because the failure is irreversible:
 * once a transcript reaches a third-party processor, no fix brings it back.
 */
import { describe, expect, it } from 'vitest';
import type { UUID } from '@starlink/shared-contracts';
import {
  redactTranscript,
  wasGeneratedUnderCurrentProfile,
  REDACTION_PROFILE,
  type TranscriptMessage,
} from './redaction.js';

const CONVERSATION = '018f2c5a-a1a1-7000-8000-000000000001' as UUID;

const message = (over: Partial<TranscriptMessage> & { seq: number }): TranscriptMessage => ({
  visibility: 'CUSTOMER_VISIBLE',
  body: 'Hello.',
  senderKind: 'CUSTOMER',
  ...over,
});

describe('what an AI provider may see', () => {
  it('withholds internal notes, and says how many', () => {
    const transcript = redactTranscript(CONVERSATION, [
      message({ seq: 1, body: 'My policy has not arrived.' }),
      message({
        seq: 2,
        visibility: 'INTERNAL',
        senderKind: 'EMPLOYEE',
        body: 'SENTINEL_NOTE — flagging this one, the customer complained last month too.',
      }),
      message({ seq: 3, senderKind: 'EMPLOYEE', body: 'Let me check that for you.' }),
    ]);

    // The property, checked across the WHOLE output rather than on the turns array —
    // a note leaking through some other field would pass a narrower assertion.
    expect(JSON.stringify(transcript)).not.toContain('SENTINEL_NOTE');
    expect(transcript.turns.map((t) => t.seq)).toEqual([1, 3]);
    expect(transcript.withheld.internalNotes).toBe(1);
  });

  it('includes an internal note ONLY under the explicitly named scope', () => {
    /**
     * The opt-in exists so the decision is visible in a diff. This test pins that it is
     * genuinely opt-in — if the default ever flips, the assertion above fails and this
     * one keeps passing, which is the pair that makes the change impossible to miss.
     */
    const messages = [
      message({ seq: 1, visibility: 'INTERNAL', senderKind: 'EMPLOYEE', body: 'SENTINEL_NOTE' }),
    ];

    expect(JSON.stringify(redactTranscript(CONVERSATION, messages))).not.toContain('SENTINEL_NOTE');
    expect(
      JSON.stringify(redactTranscript(CONVERSATION, messages, { scope: 'INCLUDING_INTERNAL_NOTES' })),
    ).toContain('SENTINEL_NOTE');
  });

  it('strips the PII patterns the log redactor knows about', () => {
    const transcript = redactTranscript(CONVERSATION, [
      message({ seq: 1, body: 'Email me at asha.rao@example.com or call +919876543210.' }),
      message({ seq: 2, body: 'My PAN is ABCDE1234F and Aadhaar 123456789012.' }),
    ]);

    const serialised = JSON.stringify(transcript);
    for (const secret of [
      'asha.rao@example.com',
      '919876543210',
      'ABCDE1234F',
      '123456789012',
    ]) {
      expect(serialised, `${secret} reached the provider payload`).not.toContain(secret);
    }
    // Not merely emptied — the sentence around the PII survives, or the model is being
    // handed a transcript it cannot reason about.
    expect(transcript.turns[0]?.text).toContain('Email me at');
  });

  it('sends roles, never names', () => {
    const transcript = redactTranscript(CONVERSATION, [
      message({ seq: 1, senderKind: 'CUSTOMER' }),
      message({ seq: 2, senderKind: 'EMPLOYEE' }),
      message({ seq: 3, senderKind: 'SYSTEM' }),
      message({ seq: 4, senderKind: 'AI' }),
    ]);

    expect(transcript.turns.map((t) => t.speaker)).toEqual([
      'CUSTOMER',
      'AGENT',
      'SYSTEM',
      'AI',
    ]);
  });

  it('attributes an unrecognised sender to SYSTEM, never to the customer', () => {
    /**
     * The safe direction. An unattributable message labelled CUSTOMER is an injected
     * instruction wearing the one label a model is most likely to treat as a genuine
     * request — §65's red-team lists prompt injection first.
     */
    const transcript = redactTranscript(CONVERSATION, [
      message({ seq: 1, senderKind: 'PARTNER_BOT' }),
    ]);

    expect(transcript.turns[0]?.speaker).toBe('SYSTEM');
  });

  it('offers no way to flatten itself into a prompt', () => {
    /**
     * Prompt injection is enabled by concatenation. This asserts the SHAPE of the module
     * rather than a behaviour: there is no `toPrompt`, no `text` on the transcript, and
     * `turns` is structured — so a caller that wants a single string has to write the
     * concatenation where a reviewer can see it.
     */
    const transcript = redactTranscript(CONVERSATION, [message({ seq: 1 })]);

    expect(Object.keys(transcript).sort()).toEqual(['ref', 'turns', 'withheld']);
    expect(transcript).not.toHaveProperty('prompt');
    expect(transcript).not.toHaveProperty('text');
  });

  it('reports upToSeq as the highest message CONSIDERED, not the highest included', () => {
    // Otherwise a conversation ending in an internal note re-examines that note for ever.
    const transcript = redactTranscript(CONVERSATION, [
      message({ seq: 7 }),
      message({ seq: 8, visibility: 'INTERNAL', senderKind: 'EMPLOYEE' }),
    ]);

    expect(transcript.ref.upToSeq).toBe(8);
    expect(transcript.turns).toHaveLength(1);
  });

  it('keeps a turn that was entirely PII, as a redaction marker', () => {
    /**
     * A message consisting only of a phone number becomes `[redacted]` and is KEPT. The
     * marker is not a leak and it is real context — "the customer sent a contact detail
     * here" is exactly what a handoff summary should be able to say without knowing what
     * the detail was. Dropping it would make the transcript claim the customer said
     * nothing at that point.
     */
    const transcript = redactTranscript(CONVERSATION, [
      message({ seq: 1, body: '+919876543210' }),
      message({ seq: 2, body: 'Thanks.' }),
    ]);

    expect(transcript.turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(transcript.turns[0]?.text).not.toContain('919876543210');
    expect(transcript.withheld.empty).toBe(0);
  });

  it('drops a turn with no text at all, and counts it', () => {
    // Whitespace only — an attachment-only message, or a client bug. There is nothing to
    // send, and an empty turn would tell the model somebody spoke and give it no words.
    const transcript = redactTranscript(CONVERSATION, [
      message({ seq: 1, body: '   \n  ' }),
      message({ seq: 2, body: 'Thanks.' }),
    ]);

    expect(transcript.turns.map((t) => t.seq)).toEqual([2]);
    expect(transcript.withheld.empty).toBe(1);
  });

  it('stamps the profile so a stored advisory can be re-checked against it', () => {
    const transcript = redactTranscript(CONVERSATION, [message({ seq: 1 })]);

    expect(transcript.ref.redactionProfile).toBe(REDACTION_PROFILE);
    expect(wasGeneratedUnderCurrentProfile(transcript.ref)).toBe(true);
    expect(wasGeneratedUnderCurrentProfile({ redactionProfile: 'starlink-redaction-v0' })).toBe(
      false,
    );
  });
});

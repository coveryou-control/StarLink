/**
 * How long, and how large, a voice note may be.
 *
 * ## Why this is not five minutes
 *
 * The obvious cap is a short one, and it is the wrong instrument. People send a voice note
 * precisely when the thing is too involved to type — a walkthrough of a claim, the context
 * behind a decision, an answer that would take four paragraphs. A cap tuned to "a quick
 * message" refuses exactly the messages the feature exists for, and it refuses them at the
 * end, after the recording is made.
 *
 * So the ceiling is an operator's setting (`SL_VOICE_NOTE_MAX_SECONDS`, thirty minutes by
 * default) rather than a constant, and the size ceiling sits beside it because duration
 * alone does not bound bytes — a browser that records at a higher rate reaches the same
 * minutes in more megabytes. Opus at the rate browsers use is roughly 6 KB/s, so twenty
 * minutes is about 7 MB and the 16 MB default leaves real headroom.
 *
 * ## Why it refuses before the grant, and with a distinguishable error
 *
 * Before: a grant means a storage slot and an audited row, and the answer to "is this
 * allowed" does not need either. It also means the recorder is told at the moment it asks,
 * not after somebody has spoken for twenty minutes.
 *
 * Distinguishable: §27.3 requires an AUTHORIZATION refusal to be indistinguishable from a
 * missing object, so that probing cannot map what exists. This is not one. The caller has
 * already been authorised for the conversation; what they proposed is simply too big.
 * Collapsing it into the uniform 404 would tell someone allowed to be here nothing about
 * why their recording vanished — and there is nothing to leak, because they can already
 * see the conversation.
 */

export interface VoiceNoteLimits {
  readonly maxSeconds: number;
  readonly maxBytes: number;
}

export type VoiceNoteRefusal =
  | { readonly error: 'voice_note_too_long'; readonly maxSeconds: number }
  | { readonly error: 'voice_note_too_large'; readonly maxBytes: number };

export interface ProposedAttachment {
  readonly declaredMime: string;
  readonly declaredBytes: number;
  readonly durationMs?: number | undefined;
}

/**
 * `undefined` when the upload may proceed.
 *
 * Applies to audio only. A PDF has no duration and is bounded by the general attachment
 * size policy; running it past a voice-note ceiling would be a second, quieter size limit
 * on documents that nothing documents.
 */
export function refuseVoiceNote(
  proposed: ProposedAttachment,
  limits: VoiceNoteLimits,
): VoiceNoteRefusal | undefined {
  if (!proposed.declaredMime.startsWith('audio/')) return undefined;

  /* A missing duration is treated as zero rather than as "unbounded". The client is the
     only thing that can measure this, so an absent value is a recorder that did not say —
     and the safe reading of silence is the one that cannot be used to bypass the ceiling. */
  const seconds = (proposed.durationMs ?? 0) / 1000;
  if (seconds > limits.maxSeconds) {
    return { error: 'voice_note_too_long', maxSeconds: limits.maxSeconds };
  }

  if (proposed.declaredBytes > limits.maxBytes) {
    return { error: 'voice_note_too_large', maxBytes: limits.maxBytes };
  }

  return undefined;
}

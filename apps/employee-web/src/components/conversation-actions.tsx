'use client';

/**
 * What an agent can DO to the conversation they are looking at.
 *
 * Every action here has existed as a tested, guarded API endpoint for weeks and had no
 * way to be invoked from the product. An agent could read and reply and nothing else —
 * they could not finish a conversation, hand it on, escalate it, or arrange cover.
 *
 * | Control          | Tracker | Rule it carries |
 * |------------------|---------|-----------------|
 * | Resolve / Reopen | SL-016  | BR-19 — owner or lead, and an outcome is recorded |
 * | Transfer         | SL-042  | BR-15 — every ownership change carries a reason |
 * | Escalate         | SL-043  | §21.4 — a level, never a state |
 * | Cover            | SL-039  | §21.9 — ownership does NOT move |
 * | SLA              | SL-047  | §22.5 — employee-only, never shown to a customer |
 *
 * ## Two properties this component exists to hold
 *
 * **A reason is not optional.** BR-15 and BR-19 make the reason part of the act, and the
 * API refuses without one. The submit button stays disabled rather than letting the server
 * reject — the same rule, enforced where the person can see it, and still enforced on the
 * server where it counts.
 *
 * **A provisional SLA target is labelled.** §68 gate 8: targets are D-22 and unratified,
 * seeded as placeholders. A number presented as a settled promise is how a placeholder
 * becomes policy, so `provisional` is rendered, not swallowed.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type DirectoryEntry, type SlaView } from '../lib/api-client';
import { ColleaguePicker } from './colleague-picker';

type Action = 'resolve' | 'reopen' | 'transfer' | 'escalate' | 'cover';

const REASON_LABEL: Record<Action, string> = {
  // §21.4's "Reason required: Yes — the outcome". The word matters: an agent is recording
  // what happened for the customer, not writing a note to themselves.
  resolve: 'What was the outcome? The customer is told this.',
  reopen: 'Why are you reopening it?',
  transfer: 'Why is it moving?',
  escalate: 'Why is it being escalated?',
  cover: 'Why is cover needed?',
};

const NEEDS_PRINCIPAL: ReadonlySet<Action> = new Set(['transfer', 'escalate', 'cover']);

export function ConversationActions({
  conversationId,
  state,
  onChanged,
}: {
  readonly conversationId: string;
  /**
   * The conversation's current lifecycle state.
   *
   * Explicitly `| undefined` rather than optional: `exactOptionalPropertyTypes` is on, and
   * the caller always passes the property — it is the VALUE that may be absent, because an
   * internal thread has no lifecycle (BR-23). "Not supplied" and "has none" are different
   * facts and the type says so.
   */
  readonly state: string | undefined;
  readonly onChanged: () => void;
}): React.JSX.Element | null {
  const [action, setAction] = useState<Action | undefined>();
  const [reason, setReason] = useState('');
  /**
   * The chosen colleague, not a raw id.
   *
   * Holding the whole entry is what lets the form show a NAME back before an agent
   * commits an irreversible move. Only `principalId` is ever sent.
   */
  const [colleague, setColleague] = useState<DirectoryEntry | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [sla, setSla] = useState<SlaView | undefined>();

  const loadSla = useCallback(async () => {
    try {
      setSla(await api.sla(conversationId));
    } catch {
      // §22.5 gives no SLA where no target is configured (D-22). Absent is the honest
      // rendering — a zeroed clock would imply a promise that was never made.
      setSla(undefined);
    }
  }, [conversationId]);

  useEffect(() => {
    if (state !== undefined) void loadSla();
  }, [state, loadSla]);

  /**
   * §21.4, and D-15 for the absent case: an internal thread has no lifecycle at all —
   * "a thread exists and stays open indefinitely". Rendering nothing is correct; showing
   * disabled buttons would imply the actions exist and are merely unavailable.
   */
  if (state === undefined || state === null) return null;

  const resolvable = state === 'ACTIVE' || state === 'WAITING_CUSTOMER' || state === 'WAITING_INTERNAL';
  const reopenable = state === 'RESOLVED';

  const submit = async (): Promise<void> => {
    if (action === undefined || reason.trim() === '') return;
    setBusy(true);
    setMessage(undefined);
    try {
      switch (action) {
        case 'resolve': {
          const out = await api.resolve(conversationId, reason.trim());
          setMessage(
            out.outcome === 'RESOLVED'
              ? 'Resolved.'
              : // A customer reply or another lead got there first. Not an error.
                'Someone else changed this conversation — reloading.',
          );
          break;
        }
        case 'reopen': {
          const out = await api.reopen(conversationId, reason.trim());
          setMessage(out.outcome === 'REOPENED' ? 'Reopened.' : 'Someone else changed this conversation.');
          break;
        }
        case 'transfer': {
          // Narrowed here rather than asserted: the button is already gated on a chosen
          // colleague, and a non-null assertion would hide it if that gate ever moved.
          if (colleague === undefined) return;
          await api.transfer(conversationId, colleague.principalId, reason.trim());
          setMessage('Transferred.');
          break;
        }
        case 'escalate': {
          if (colleague === undefined) return;
          const out = await api.escalate(conversationId, colleague.principalId, reason.trim());
          setMessage(`Escalated to level ${out.level}.`);
          break;
        }
        case 'cover': {
          if (colleague === undefined) return;
          // §21.9: cover is time-boxed. Eight hours is a working day — the shift the
          // grant is meant to span — and it is chosen here rather than read from
          // configuration because no business value defines it (D-05 is the policy).
          const until = new Date(Date.now() + 8 * 3600_000).toISOString();
          const out = await api.cover(conversationId, colleague.principalId, reason.trim(), until);
          setMessage(
            out.ownerUnchanged
              ? 'Cover granted. You still own this conversation.'
              : 'Cover granted.',
          );
          break;
        }
      }
      setAction(undefined);
      setReason('');
      setColleague(undefined);
      onChanged();
      void loadSla();
    } catch (cause) {
      setMessage(
        cause instanceof ApiError && cause.isRefusal
          ? // §27.3: "not permitted" and "does not exist" are one answer. The UI must not
            // guess which, or it leaks the existence the refusal was hiding.
            'That is not available to you.'
          : 'That did not go through. Nothing was changed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="actions" aria-label="Conversation actions">
      <div className="actions-state">
        <span className="state-chip">{state.replace(/_/g, ' ').toLowerCase()}</span>
        {sla?.clocks.map((clock) => (
          <span key={clock.clock} className={`sla sla-${clock.status.toLowerCase()}`}>
            {clock.clock === 'FIRST_RESPONSE' ? 'First response' : 'Resolution'}: {clock.status.toLowerCase()}
            {/* §68 gate 8 — never let an unratified target read as a settled promise. */}
            {clock.provisional ? <em title="Target not yet signed off (D-22)"> · provisional</em> : null}
          </span>
        ))}
      </div>

      <div className="actions-buttons">
        {resolvable ? (
          <button type="button" onClick={() => setAction('resolve')}>Resolve</button>
        ) : null}
        {reopenable ? (
          <button type="button" onClick={() => setAction('reopen')}>Reopen</button>
        ) : null}
        <button type="button" onClick={() => setAction('transfer')}>Transfer</button>
        <button type="button" onClick={() => setAction('escalate')}>Escalate</button>
        <button type="button" onClick={() => setAction('cover')}>Arrange cover</button>
      </div>

      {action !== undefined ? (
        <form
          className="actions-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {NEEDS_PRINCIPAL.has(action) ? (
            <ColleaguePicker selected={colleague} onSelect={setColleague} />
          ) : null}

          <label>
            {REASON_LABEL[action]}
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
          </label>

          <div className="actions-form-buttons">
            <button
              type="submit"
              /* BR-15 / BR-19: the reason is part of the act, so it gates the button. */
              disabled={busy || reason.trim() === '' || (NEEDS_PRINCIPAL.has(action) && colleague === undefined)}
            >
              {busy ? 'Working…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAction(undefined);
                setColleague(undefined);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {message !== undefined ? <p role="status" className="actions-message">{message}</p> : null}
    </section>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  ApiError,
  api,
  type Category,
  type ConversationSummary,
  type CustomerMessage,
} from '../lib/api-client';
import { VerifyPanel } from './verify-panel';

/**
 * The approved journey (2026-08-26): browse topics with no session at all → pick one →
 * "to continue, please add your details" → verify → the composer appears.
 *
 * VERIFYING sits between CHOOSING and CHATTING deliberately. A conversation cannot be
 * created below PSEUDONYMOUS, so there is no state in which someone has typed a message
 * we have no way to reply to.
 */
type Stage = 'CLOSED' | 'STARTING' | 'CHOOSING' | 'VERIFYING' | 'CHATTING' | 'UNAVAILABLE';

/**
 * D-26's proposed wording. PROPOSED, not ratified (§44.5) — the business owns these
 * words, and they change here without touching the mapping that decides which internal
 * states collapse into each one.
 *
 * `CLOSED` is deliberately absent. §21.4 gives `resolved → closed` a "Customer notified:
 * No", so a closed conversation still reads as resolved to the person who had it.
 */
const STATUS_LABEL: Record<string, string> = {
  RECEIVED: 'Received',
  BEING_LOOKED_AT: 'Being looked at',
  WAITING_FOR_YOU: 'Waiting for you',
  RESOLVED: 'Resolved',
};

/**
 * Shown when the API sends a status this build does not know.
 *
 * Never the raw value: an unrecognised status is exactly the case where rendering what
 * the server said would put an internal state name in front of a customer (§27.16). The
 * safe fallback claims the least — the same direction the server-side mapping takes.
 */
const UNKNOWN_STATUS_LABEL = 'Received';

/**
 * The customer chat surface.
 *
 * Deliberately NOT a persistent draft store. `employee-web` keeps unsent text in
 * IndexedDB because an agent's machine is their own and losing a half-written reply
 * costs real work. A customer's device is often shared, sometimes public, and the text
 * they were typing may be about a claim or a complaint — so it lives in component state
 * and goes when the tab does. Losing a sentence is the cheaper failure.
 *
 * No session exists until the customer supplies a contact detail. Browsing topics is
 * public, so opening the widget, reading the list and closing it mints no principal and
 * writes no audit entry — §21.5: "a customer who abandons at the category step has
 * disclosed nothing."
 */
export function Chat(): ReactNode {
  const [stage, setStage] = useState<Stage>('CLOSED');
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [conversation, setConversation] = useState<ConversationSummary | undefined>(undefined);
  const [messages, setMessages] = useState<readonly CustomerMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<{ localId: string; body: string; failed: boolean }[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * Monotonic ticket for reads, so a slow response cannot overwrite a newer one.
   * A ref rather than state: it must be readable and writable without a re-render.
   */
  const requestSeq = useRef(0);

  const open = useCallback(async () => {
    setStage('STARTING');
    setError(undefined);
    try {
      // No session yet. Categories are public precisely so that reading the topics and
      // closing the widget leaves nothing behind (§21.5).
      const { categories: available } = await api.categories();
      setCategories(available);
      setStage('CHOOSING');
    } catch (cause) {
      setStage('UNAVAILABLE');
      setError(
        cause instanceof ApiError && cause.isUnreachable
          ? 'We could not reach us just now. Please try again in a moment.'
          : 'Chat is unavailable right now.',
      );
    }
  }, []);

  /** Runs once assurance has been raised: resume a live conversation, or open the composer. */
  const afterVerified = useCallback(async () => {
    try {
      const { conversations } = await api.conversations();
      const existing = conversations[0];
      if (existing !== undefined) {
        const page = await api.messages(existing.conversationId);
        setConversation(page.conversation);
        setMessages(page.messages);
      }
      setStage('CHATTING');
    } catch {
      // Verified but the follow-up read failed: let them type rather than trapping them
      // behind a screen they have already satisfied.
      setStage('CHATTING');
    }
  }, []);

  /**
   * Re-reads a conversation. Returns whether it actually succeeded.
   *
   * The boolean matters on the send path: the optimistic bubble may only be removed once
   * something has replaced it. Before, `send` dropped the bubble and then called this, and
   * this swallows every non-401 failure — so a failed read left the message on no screen at
   * all, with no error. That is the exact symptom the fork fix was written to remove,
   * surviving in a narrower window.
   */
  const refresh = useCallback(async (conversationId: string): Promise<boolean> => {
    /**
     * Only the NEWEST read may write state.
     *
     * The 8-second poll and the post-send re-read are separate in-flight requests against
     * possibly different conversations, and nothing ordered them. A poll issued against
     * the OLD id a moment before a BR-22 fork would land after the send's `refresh(newId)`
     * and overwrite the thread with the pre-fork one — the customer's message off the
     * screen again, and `conversation` pointing back at the resolved thread so the next
     * send went there too. That is the defect this component was changed to fix,
     * reappearing inside an 8-second window.
     *
     * `clearInterval` in the effect's cleanup stops the TIMER, not a fetch already in
     * flight, so the ordering has to be enforced here.
     */
    const ticket = requestSeq.current + 1;
    requestSeq.current = ticket;

    try {
      const page = await api.messages(conversationId);
      // A superseded response is discarded rather than applied late.
      if (ticket !== requestSeq.current) return false;
      setConversation(page.conversation);
      setMessages(page.messages);
      return true;
    } catch (cause) {
      if (ticket !== requestSeq.current) return false;
      if (cause instanceof ApiError && cause.isUnauthenticated) {
        // The session lapsed. Say so plainly rather than silently showing an empty
        // thread, which reads as "your messages are gone".
        setStage('UNAVAILABLE');
        setError('Your chat session ended. Please start again.');
      }
      return false;
    }
  }, []);

  // Poll while chatting. Realtime for the customer surface arrives with the shared
  // backplane (Phase 3, Redis); until then a slow poll is honest and costs little.
  useEffect(() => {
    if (stage !== 'CHATTING' || conversation === undefined) return;
    const id = setInterval(() => void refresh(conversation.conversationId), 8000);
    return () => clearInterval(id);
  }, [stage, conversation, refresh]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [messages, pending]);

  const startConversation = useCallback(async () => {
    const text = draft.trim();
    if (text === '') return;

    const localId = `local-${performance.now()}`;
    setPending([{ localId, body: text, failed: false }]);
    setDraft('');
    setError(undefined);

    try {
      const started = await api.startConversation({
        ...(categoryId !== undefined ? { categoryId } : {}),
        message: text,
      });
      const page = await api.messages(started.conversationId);
      setConversation(page.conversation);
      setMessages(page.messages);
      setPending([]);
      setStage('CHATTING');
    } catch (cause) {
      setPending((current) => current.map((p) => ({ ...p, failed: true })));
      setDraft(text);
      setError(
        cause instanceof ApiError && cause.isRefusal
          ? 'We could not start that conversation. Please try a different topic.'
          : 'Your message was not sent. Please try again.',
      );
    }
  }, [draft, categoryId]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === '' || conversation === undefined) return;

    const localId = `local-${performance.now()}`;
    setPending((current) => [...current, { localId, body: text, failed: false }]);
    setDraft('');
    setError(undefined);

    try {
      /**
       * Refresh the conversation the server WROTE TO, not the one we sent to.
       *
       * Past the reopen window BR-22 continues the customer on a new conversation against
       * the same case, and the response carries that id. Refreshing the id we sent showed
       * the customer a thread their message was not in — their words simply vanished, with
       * no error, on the surface where that is least acceptable.
       */
      const sent = await api.send(conversation.conversationId, text, localId);

      /**
       * Follow the fork IMMEDIATELY, before the re-read and independently of whether it
       * succeeds.
       *
       * The id used to be adopted only as a side effect of `refresh` succeeding, and
       * `refresh` swallows every non-401 failure. One dropped GET therefore left
       * `conversation` pointing at the superseded thread: the poll kept re-reading a
       * conversation the message is not in, and the customer's next send — or a Retry —
       * went to the old id. The server now redirects that case, but the widget should not
       * be relying on the server to correct an id it was handed and ignored.
       */
      if (sent.conversationId !== conversation.conversationId) {
        setConversation((current) =>
          current === undefined ? current : { ...current, conversationId: sent.conversationId },
        );
      }

      // Reconcile BEFORE dropping the optimistic row, and only drop it if the re-read
      // actually landed. Otherwise the bubble stays and the 8-second poll reconciles it —
      // the words are never on no screen at all.
      if (await refresh(sent.conversationId)) {
        setPending((current) => current.filter((p) => p.localId !== localId));
      }
    } catch {
      /**
       * Never silently dropped: the failed bubble stays on screen holding the words, so
       * "did that send?" has an answer (§19.4).
       *
       * The text is deliberately NOT put back in the composer. `localId` is the
       * idempotency key, and a send that timed out may well have landed — retyping and
       * pressing Send would submit the same words under a NEW key, which is precisely how
       * a customer's message gets posted twice. Retry lives on the bubble instead, where
       * it can reuse this key.
       */
      setPending((current) => current.map((p) => (p.localId === localId ? { ...p, failed: true } : p)));
      setError('Your message was not sent. Please try again.');
    }
  }, [draft, conversation, refresh]);

  /**
   * §19.4's "marked failed on error **with a retry**", and its "reconciled by server id".
   *
   * Re-sends under the ORIGINAL `localId`. If the first attempt actually reached the
   * server, the write is recognised as a duplicate and no second message is created; if
   * it did not, this is the first. Either way the pending row is reconciled away, which
   * is the half that was missing: a failed bubble used to persist for the rest of the
   * session, so a customer who successfully resent saw their message apparently delivered
   * AND not sent at the same time.
   */
  const retry = useCallback(
    async (item: { localId: string; body: string }) => {
      if (conversation === undefined) return;
      setPending((current) =>
        current.map((p) => (p.localId === item.localId ? { ...p, failed: false } : p)),
      );
      setError(undefined);
      try {
        // Same redirect as the first attempt: a retry can be the send that crosses the
        // window, and it must follow the fork too.
        const sent = await api.send(conversation.conversationId, item.body, item.localId);
        if (await refresh(sent.conversationId)) {
          setPending((current) => current.filter((p) => p.localId !== item.localId));
        }
      } catch {
        setPending((current) =>
          current.map((p) => (p.localId === item.localId ? { ...p, failed: true } : p)),
        );
        setError('Your message was not sent. Please try again.');
      }
    },
    [conversation, refresh],
  );

  if (stage === 'CLOSED') {
    return (
      <button type="button" onClick={() => void open()} style={launcherStyle}>
        Chat with us
      </button>
    );
  }

  return (
    <section aria-label="Chat with CoverYou" style={panelStyle}>
      <header style={headerStyle}>
        <strong>CoverYou</strong>
        {conversation !== undefined ? (
          <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-muted)' }}>
            {STATUS_LABEL[conversation.status] ?? UNKNOWN_STATUS_LABEL}
          </span>
        ) : null}
      </header>

      <div ref={scrollRef} style={bodyStyle}>
        {/**
         * BR-20's second half — "the customer is told the conversation was resolved, and
         * why". The status word alone says only that it ended.
         *
         * Rendered as the agent wrote it, which is what §22.5's "Outcome only" grants.
         * Deliberately NOT accompanied by a resolution time: the same §22.5 row gives the
         * customer the outcome and withholds when it happened, and the API does not send
         * it. Placed above the thread rather than inside it because it is a property of
         * the conversation, not a message somebody sent.
         */}
        {conversation?.outcome != null && conversation.outcome !== '' ? (
          <p style={outcomeStyle}>{conversation.outcome}</p>
        ) : null}

        {stage === 'STARTING' ? <p style={mutedStyle}>Connecting…</p> : null}

        {stage === 'UNAVAILABLE' ? (
          <div style={{ padding: 16 }}>
            <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>
            <button type="button" onClick={() => void open()} style={secondaryButtonStyle}>
              Try again
            </button>
          </div>
        ) : null}

        {stage === 'CHOOSING' ? (
          <div style={{ padding: 16 }}>
            <p style={{ marginTop: 0 }}>What can we help with?</p>
            <CategoryPicker
              categories={categories}
              selected={categoryId}
              onSelect={setCategoryId}
            />
            <button
              type="button"
              onClick={() => setStage('VERIFYING')}
              style={{
                marginTop: 16,
                width: '100%',
                padding: 12,
                borderRadius: 'var(--radius)',
                border: 'none',
                fontWeight: 600,
                background: 'var(--accent)',
                color: 'var(--accent-contrast)',
              }}
            >
              Continue
            </button>
          </div>
        ) : null}

        {stage === 'VERIFYING' ? <VerifyPanel onVerified={() => void afterVerified()} /> : null}

        {stage === 'CHATTING' || pending.length > 0 ? (
          <ol style={listStyle}>
            {messages.map((message) => (
              <MessageBubble key={message.messageId} message={message} />
            ))}
            {pending.map((item) => (
              <li key={item.localId} style={{ ...bubbleStyle('YOU'), opacity: item.failed ? 1 : 0.6 }}>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.body}</div>
                <div style={{ fontSize: 12, marginTop: 4, color: item.failed ? 'var(--danger)' : 'inherit' }}>
                  {item.failed ? (
                    <>
                      <span>⚠ Not sent</span>{' '}
                      <button type="button" onClick={() => void retry(item)} style={retryButtonStyle}>
                        Retry
                      </button>
                    </>
                  ) : (
                    'Sending…'
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {stage === 'CHATTING' ? (
        <div style={composerStyle}>
          {error !== undefined ? (
            <p role="alert" style={{ margin: '0 0 8px', color: 'var(--danger)', fontSize: 14 }}>
              {error}
            </p>
          ) : null}
          <label htmlFor="chat-message" className="sr-only">
            Your message
          </label>
          <textarea
            id="chat-message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            placeholder={conversation === undefined ? 'Tell us what you need…' : 'Type a message…'}
            style={textareaStyle}
          />
          <button
            type="button"
            onClick={() => void (conversation === undefined ? startConversation() : send())}
            disabled={draft.trim() === ''}
            style={{
              ...primaryButtonStyle,
              background: draft.trim() === '' ? 'var(--surface-2)' : 'var(--accent)',
              color: draft.trim() === '' ? 'var(--text-muted)' : 'var(--accent-contrast)',
            }}
          >
            Send
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CategoryPicker({
  categories,
  selected,
  onSelect,
}: {
  categories: readonly Category[];
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}): ReactNode {
  if (categories.length === 0) {
    // §21.5 allows starting without choosing, so an empty taxonomy is not a dead end.
    return <p style={mutedStyle}>Just tell us what you need below.</p>;
  }

  return (
    <div role="radiogroup" aria-label="Topic" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {categories.map((category) => {
        const active = category.categoryId === selected;
        return (
          <button
            key={category.categoryId}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(active ? undefined : category.categoryId)}
            style={{
              padding: '8px 12px',
              borderRadius: 999,
              border: active ? '2px solid var(--accent)' : '1px solid var(--border)',
              background: active ? 'var(--surface-2)' : 'var(--surface)',
              fontWeight: active ? 600 : 400,
            }}
          >
            {category.displayName}
            {category.provisional ? (
              /* D-17/D-18 are unresolved. A placeholder category is labelled as one
                 rather than presented as settled taxonomy — the alternative is a real
                 customer picking a topic we invented and have not agreed. */
              <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                (draft)
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function MessageBubble({ message }: { message: CustomerMessage }): ReactNode {
  const mine = message.author.kind === 'YOU';
  return (
    <li style={bubbleStyle(message.author.kind)}>
      {!mine ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 }}>
          {message.author.displayName}
        </div>
      ) : null}
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{message.body}</div>
      <time
        dateTime={message.createdAt}
        style={{
          display: 'block',
          fontSize: 11,
          marginTop: 4,
          /**
           * The muted grey is only readable on a light bubble. The customer's own message
           * sits on the accent, where the same colour all but disappeared - a contrast
           * failure rather than a stylistic one, so the timestamp follows the bubble.
           */
          color: mine ? 'rgb(255 255 255 / 78%)' : 'var(--text-muted)',
        }}
      >
        {new Date(message.createdAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </time>
    </li>
  );
}

const launcherStyle: React.CSSProperties = {
  position: 'fixed',
  right: 'var(--space-5)',
  bottom: 'var(--space-5)',
  padding: '0 var(--space-5)',
  height: 48,
  borderRadius: 'var(--radius-pill)',
  border: '1px solid transparent',
  background: 'var(--accent)',
  color: 'var(--accent-contrast)',
  fontWeight: 600,
  fontSize: 15,
  letterSpacing: '-0.005em',
  // The token, not a hard black: a flat rgba shadow reads as a sticker on a dark page.
  boxShadow: 'var(--shadow-md)',
};

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'grid',
  gridTemplateRows: 'auto 1fr auto',
  background: 'var(--surface)',
  // Full-screen on a phone; a floating panel once there is room for one.
  maxWidth: 420,
  maxHeight: 640,
  margin: 'auto',
  borderRadius: 'var(--radius)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  overflow: 'hidden',
  // The widget genuinely floats over the page, so it is one of the few things that
  // earns elevation rather than a border alone.
  boxShadow: 'var(--shadow-md)',
};

const headerStyle: React.CSSProperties = {
  background: 'var(--surface)',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  padding: 'var(--space-3) var(--space-4)',
  borderBottom: '1px solid var(--border)',
  fontWeight: 620,
  letterSpacing: '-0.01em',
  minHeight: 52,
};

const bodyStyle: React.CSSProperties = { overflowY: 'auto', minHeight: 0 };
const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 'var(--space-3)',
  display: 'grid',
  // Comfortable rather than compact: a customer reads a handful of messages once, where
  // an agent scans hundreds all day. The two surfaces differ here on purpose.
  gap: 'var(--space-3)',
};
const mutedStyle: React.CSSProperties = {
  padding: 'var(--space-5) var(--space-4)',
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: 15,
  textAlign: 'center',
};

/** The resolution outcome (BR-20). Set apart from the thread — it is not a message. */
const outcomeStyle: React.CSSProperties = {
  margin: 0,
  padding: 'var(--space-3) var(--space-4)',
  background: 'var(--accent-soft)',
  borderBottom: '1px solid var(--accent-line)',
  color: 'var(--text)',
  fontSize: 14,
  fontWeight: 550,
};

/**
 * A message bubble.
 *
 * The customer's own messages sit right on the accent; ours sit left on a neutral. Side
 * is the cue that actually reads at a glance - colour only reinforces it, which is what
 * keeps the thread legible for someone who cannot separate the two hues.
 *
 * The asymmetric corner (square on the side the bubble is anchored to) is the small
 * detail that makes a thread look composed rather than like a list of rounded boxes.
 */
const bubbleStyle = (kind: 'YOU' | 'AGENT' | 'SYSTEM'): React.CSSProperties => ({
  justifySelf: kind === 'YOU' ? 'end' : 'start',
  maxWidth: '82%',
  padding: '8px 12px',
  borderRadius:
    kind === 'YOU'
      ? 'var(--radius) var(--radius) var(--radius-sm) var(--radius)'
      : 'var(--radius) var(--radius) var(--radius) var(--radius-sm)',
  background: kind === 'YOU' ? 'var(--accent)' : 'var(--surface-2)',
  color: kind === 'YOU' ? 'var(--accent-contrast)' : 'var(--text)',
  border: '1px solid transparent',
  fontSize: 15,
  lineHeight: 1.5,
});

const composerStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border)',
  padding: 'var(--space-3) var(--space-4) var(--space-4)',
  display: 'grid',
  gap: 'var(--space-2)',
  background: 'var(--surface)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  resize: 'none',
  padding: 'var(--space-3)',
  borderRadius: 'var(--radius-sm)',
  // The strong border, not the hairline: this is an input, and an input that does not
  // look like one is the commonest reason a chat widget reads as "not ready yet".
  border: '1px solid var(--border-strong)',
  background: 'var(--surface)',
  lineHeight: 1.5,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '0 var(--space-5)',
  minHeight: 44,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid transparent',
  fontWeight: 620,
  fontSize: 15,
  letterSpacing: '-0.005em',
};

/** Inline and quiet: it sits inside a failed bubble, not beside the composer. */
const retryButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid currentColor',
  borderRadius: 'var(--radius-pill)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  padding: '2px 10px',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '0 var(--space-4)',
  minHeight: 40,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-strong)',
  background: 'var(--surface)',
  fontWeight: 550,
};

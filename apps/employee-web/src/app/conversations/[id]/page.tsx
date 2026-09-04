'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TypingFrame } from '@starlink/shared-contracts/realtime';

import { Composer, type PendingSend } from '../../../components/composer';
import { ConversationActions } from '../../../components/conversation-actions';
import { Participants } from '../../../components/participants';
import { MessageList } from '../../../components/message-list';
import { useSession } from '../../../components/session-provider';
import { ApiError, api, type MessageView } from '../../../lib/api-client';
import { useRealtime } from '../../../lib/use-realtime';
import { ChatHeader } from '../../../components/chat-header';
import { avatarFor, conversationLabel } from '../../../components/conversation-naming';
import {
  ColleagueRole,
  ConversationControls,
  EmployeeDetails,
  SharedFiles,
} from '../../../components/conversation-info';
import { ConversationSearch } from '../../../components/conversation-search';
import { ConfirmDialog } from '../../../components/confirm-dialog';
import { GroupGlyph } from '../../../components/group-glyph';
import { useMediaQuery } from '../../../lib/use-media-query';
import {
  useActiveConversation,
  useRefreshConversations,
} from '../../../components/active-conversation';
import { customerWorkspaceEnabled } from '../../../lib/runtime-origins';

/**
 * Read marking is debounced (FR-READ-4).
 *
 * Two reasons, and the second is the one that bites: marking on every render would
 * write on every realtime event and every scroll, and a burst of writes arriving out of
 * order would need the server's `GREATEST` guard to do all the work. Debouncing means
 * one write per pause, and the server's monotonic marker then covers the residual race
 * rather than the whole traffic pattern.
 */
const READ_DEBOUNCE_MS = 800;

export default function ThreadPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const conversationId = params.id;
  const { state, onUnauthenticated } = useSession();

  const [messages, setMessages] = useState<readonly MessageView[]>([]);
  const [lifecycleState, setLifecycleState] = useState<string | undefined>(undefined);
  const [typing, setTyping] = useState<TypingFrame | undefined>(undefined);
  const [olderCursor, setOlderCursor] = useState<string | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pending, setPending] = useState<readonly PendingSend[]>([]);
  /**
   * UC-E16. Held on the page rather than in either component, because the message being
   * replied to is chosen in the LIST and sent from the COMPOSER - it is the one piece of
   * state the two share.
   */
  const [replyingTo, setReplyingTo] = useState<MessageView | undefined>();
  /**
   * The conversation kind, from the same read as the messages.
   *
   * Distinct from `lifecycleState`, which is absent BOTH for an internal thread and for
   * a page that has not loaded - and the composer must not guess between those.
   */
  const [conversationType, setConversationType] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  /** Stage 1 gate; read per render for the reason `runtimeOrigins` is. */
  const showCustomerWorkspace = customerWorkspaceEnabled();
  /** Supplied by the shell, which already loaded it for the sidebar. */
  const activeConversation = useActiveConversation();
  const refreshConversations = useRefreshConversations();
  /**
   * Closed by default, and closed again whenever the conversation changes.
   *
   * The `key` on the thread column already remounts this page per conversation, so the
   * initial value is the whole of that rule — there is no stale-open case to handle.
   */
  /**
   * Two states, because the panel has two behaviours and one flag cannot hold both.
   *
   * As a COLUMN it is part of the composition and is there unless you hid it. As an OVERLAY
   * it covers the conversation, so it is absent unless you asked for it. A single
   * `detailsOpen` defaulting to true gave the second the first's default, and a tablet
   * opened every thread with the information panel on top of the messages.
   *
   * Kept apart rather than reset on resize: hiding the panel on a wide screen and then
   * narrowing the window should not open it, and vice versa.
   */
  const [columnHidden, setColumnHidden] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);

  /** The header's magnifier: the same search, narrowed to this thread. */
  const [searchOpen, setSearchOpen] = useState(false);


  /**
   * The unread count as it was when this conversation was opened, for the "New" rule.
   *
   * Frozen deliberately. Opening marks the thread read, so the live count collapses to
   * zero within a second and a divider driven by it would appear and then disappear under
   * the reader. `useRef` rather than state: it must not cause a render of its own, and the
   * only write is the first non-undefined summary for this conversation.
   */
  const unreadOnOpen = useRef(0);
  const unreadCapturedFor = useRef<string | undefined>(undefined);
  if (activeConversation !== undefined && unreadCapturedFor.current !== conversationId) {
    unreadCapturedFor.current = conversationId;
    unreadOnOpen.current = activeConversation.unreadCount;
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackerRef = useRef<{ reset: (id: string, seq: number) => void } | undefined>(undefined);

  // Highest seq already reported as read, so a debounce firing with nothing new does
  // not spend a request saying so.
  const reportedSeq = useRef(0);
  const readTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * How far every OTHER participant has read — what turns one tick into two.
   *
   * Seeded from the page read and raised by socket frames, never lowered by one: the
   * watermark is monotonic within a session, so an out-of-order frame is harmless. A
   * re-fetch may legitimately move it DOWN (somebody was added to the group and has not
   * read), which is why the authoritative read assigns rather than maxes.
   */
  const [readWatermark, setReadWatermark] = useState(0);

  /**
   * The authoritative read. Called on mount, on every socket (re)connect, and whenever
   * a sequence gap is detected — realtime is a hint, this is the truth (FR-RT-1).
   */
  const refetch = useCallback(async () => {
    try {
      const page = await api.messages(conversationId);
      // The API returns newest-first for paging; the thread reads oldest-first.
      const ordered = [...page.messages].sort((a, b) => a.seq - b.seq);
      setMessages(ordered);
      setOlderCursor(page.nextCursor);
      // §21.4's state, from the same read as the messages — the action panel offers
      // resolve or reopen depending on it, and a stale value would offer the wrong one.
      setLifecycleState(page.state);
      setConversationType(page.conversationType);
      // Assigned, not raised: this read is the truth, and the watermark can legitimately
      // fall when somebody joins the conversation who has not read it yet (BR-07).
      setReadWatermark(page.readWatermark ?? 0);
      setError(undefined);

      const newest = ordered.at(-1);
      if (newest !== undefined) trackerRef.current?.reset(conversationId, newest.seq);
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthenticated) {
        onUnauthenticated();
        return;
      }
      setError(
        cause instanceof ApiError && cause.isRefusal
          ? 'This conversation is not available.'
          : 'Could not load this conversation.',
      );
    } finally {
      setLoading(false);
    }
  }, [conversationId, onUnauthenticated]);

  /**
   * Toggles one of the reader's own reactions.
   *
   * Optimistic, then reconciled by the authoritative re-read. The server is idempotent on
   * the whole (message, principal, emoji) tuple, so a double tap is one row and a failed
   * request leaves the next `refetch` to correct the display — the alternative, waiting
   * for the round trip before showing anything, makes a one-tap gesture feel broken.
   */
  const react = useCallback(
    (messageId: string, emoji: string, on: boolean) => {
      setMessages((current) =>
        current.map((message) => {
          if (message.messageId !== messageId) return message;
          const existing = message.reactions ?? [];
          const found = existing.find((r) => r.emoji === emoji);
          const next = on
            ? found === undefined
              ? [...existing, { emoji, count: 1, mine: true }]
              : existing.map((r) =>
                  r.emoji === emoji ? { ...r, count: r.count + 1, mine: true } : r,
                )
            : existing
                .map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, mine: false } : r))
                .filter((r) => r.count > 0);
          return { ...message, reactions: next };
        }),
      );

      const call = on
        ? api.react(conversationId, messageId, emoji)
        : api.unreact(conversationId, messageId, emoji);
      void call.catch(() => undefined).then(() => refetch());
    },
    [conversationId, refetch],
  );

  /**
   * Corrects one of your own messages.
   *
   * `window.prompt` rather than an inline editor, deliberately and temporarily. An inline
   * editor inside a message bubble is a real piece of work — it has to grow, keep the
   * caret, handle Escape and Enter, preserve mentions across the edit and reconcile with
   * the optimistic row — and doing it badly is worse than a plain dialog. The API, the
   * revision history and the permission are all real; only the input surface is plain.
   */
  const editMessage = useCallback(
    (message: MessageView) => {
      const next = window.prompt('Edit this message', message.body);
      if (next === null || next.trim() === '' || next.trim() === message.body) return;
      // Optimistic, then reconciled: the same shape as reacting, for the same reason.
      setMessages((current) =>
        current.map((m) =>
          m.messageId === message.messageId
            ? { ...m, body: next.trim(), editedAt: new Date().toISOString() }
            : m,
        ),
      );
      void api
        .editMessage(conversationId, message.messageId, next.trim())
        .catch(() => undefined)
        .then(() => refetch());
    },
    [conversationId, refetch],
  );

  /**
   * Deletes one of your own messages.
   *
   * Confirmed, because it is not undoable from the interface — the previous text survives
   * in `message_revisions` for an investigation, but nothing in the product puts it back.
   * The row stays in the thread with its text gone, so nothing shifts under the reader.
   */
  /**
   * The message a delete has been REQUESTED for, and not yet confirmed.
   *
   * Deletion asks before it acts, and the asking is a component rather than
   * `window.confirm` — see `confirm-dialog.tsx` for why the browser's own alert could not
   * stay. Holding the message here rather than a boolean means the dialog knows what it is
   * about to destroy without the callback having to close over it.
   */
  const [deleting, setDeleting] = useState<MessageView | undefined>();

  const deleteMessage = useCallback(
    (message: MessageView) => {
      setMessages((current) =>
        current.map((m) =>
          m.messageId === message.messageId
            ? { ...m, body: '', redactedAt: new Date().toISOString() }
            : m,
        ),
      );
      void api
        .deleteMessage(conversationId, message.messageId)
        .catch(() => undefined)
        .then(() => refetch());
    },
    [conversationId, refetch],
  );

  /**
   * Loads the page BEFORE the oldest message currently shown.
   *
   * Scroll position is pinned by measuring the scroll height before and after: without
   * that, prepending older messages yanks the reader to a different part of the thread,
   * which is the standard way infinite scroll becomes unusable.
   */
  const loadOlder = useCallback(async () => {
    if (olderCursor === undefined || loadingOlder) return;
    setLoadingOlder(true);
    const element = scrollRef.current;
    const heightBefore = element?.scrollHeight ?? 0;
    const topBefore = element?.scrollTop ?? 0;

    try {
      const page = await api.messages(conversationId, { cursor: olderCursor });
      setMessages((current) => {
        const seen = new Set(current.map((m) => m.messageId));
        const merged = [...page.messages.filter((m) => !seen.has(m.messageId)), ...current];
        return merged.sort((a, b) => a.seq - b.seq);
      });
      setOlderCursor(page.nextCursor);

      requestAnimationFrame(() => {
        const after = scrollRef.current;
        if (after !== null) after.scrollTop = topBefore + (after.scrollHeight - heightBefore);
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthenticated) onUnauthenticated();
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, olderCursor, loadingOlder, onUnauthenticated]);

  const { status, tracker, notifyTyping, notifyRead } = useRealtime({
    /**
     * A colleague read the thread. Raise the watermark, never lower it — a frame that
     * arrived late must not un-tick a message that a newer frame already ticked.
     */
    onRead: (frame) => setReadWatermark((current) => Math.max(current, frame.lastReadSeq)),
    conversationId,
    onRefetch: () => void refetch(),
    // An in-order MESSAGE_CREATED still triggers a read: the event carries no body
    // (§20.4), so the content must come from the authorised REST path either way.
    onEvent: () => void refetch(),
    onSessionRevoked: onUnauthenticated,
    // SL-010. Ephemeral by design — held in component state, never persisted, and
    // cleared by its own TTL rather than by a "stopped" message that may not arrive.
    onTyping: setTyping,
  });
  trackerRef.current = tracker;

  useEffect(() => {
    setLoading(true);
    reportedSeq.current = 0;
    void refetch();
  }, [refetch]);

  // Follow the bottom of the thread as messages arrive.
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && !loadingOlder) element.scrollTop = element.scrollHeight;
  }, [messages, pending, loadingOlder]);

  // Debounced read marking.
  useEffect(() => {
    const newest = messages.at(-1)?.seq ?? 0;
    if (newest <= reportedSeq.current) return;

    if (readTimer.current !== undefined) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      reportedSeq.current = newest;
      // A failure here is deliberately silent: an unrecorded read marker is a cosmetic
      // loss, and surfacing it would put an error banner over a working conversation.
      void api
        .markRead(conversationId, newest)
        /**
         * Broadcast AFTER the write, and with the sequence the SERVER returned.
         *
         * That ordering is the whole difference between reporting state and asserting it:
         * `markRead` clamps with `GREATEST`, so the number coming back is what is durably
         * recorded. If the write fails, nothing goes on the wire and the other person's
         * tick simply turns over on their next re-fetch instead — which is rule 9 doing
         * its job rather than a case anybody has to handle.
         */
        .then(({ lastReadSeq }) => notifyRead(lastReadSeq))
        .catch(() => {
          reportedSeq.current = 0;
        });
    }, READ_DEBOUNCE_MS);

    return () => {
      if (readTimer.current !== undefined) clearTimeout(readTimer.current);
    };
  }, [messages, conversationId, notifyRead]);

  /**
   * Re-reads §21.4's state after this agent changes it.
   *
   * Sending is a lifecycle event, not just a write: §21.4 moves an ASSIGNED conversation
   * to ACTIVE on the agent's first message. Nothing else tells this page — there is no
   * `conversation.state_changed` event, deliberately (§20.7 lists no such row), and the
   * outbox carries none.
   *
   * Without this the action panel keeps the state it was rendered with, so the agent who
   * has just answered the customer is not offered Resolve at all. The thread looked
   * completely healthy, which is why only a browser found it: every unit test that
   * exercised the panel passed it the state directly.
   *
   * Only the state is taken from the response. The messages are already correct — the
   * sent one was appended above — and replacing them here would discard any older pages
   * the agent had scrolled back through.
   */
  const refreshLifecycleState = useCallback(async () => {
    try {
      const page = await api.messages(conversationId);
      setLifecycleState(page.state);
    } catch {
      // The message was sent; the panel simply keeps the state it had. Surfacing an
      // error over a successful send would be a worse lie than a stale button.
    }
  }, [conversationId]);

  const onSent = useCallback(
    (message: MessageView) => {
      setMessages((current) =>
        current.some((existing) => existing.messageId === message.messageId)
          ? current
          : [...current, message].sort((a, b) => a.seq - b.seq),
      );
      trackerRef.current?.reset(conversationId, message.seq);
      void refreshLifecycleState();
    },
    [conversationId, refreshLifecycleState],
  );

  if (state.status !== 'SIGNED_IN') return null;

  /*
    SL-002's membership half, in a drawer beside the conversation.

    Shown only for an INTERNAL thread: §21.4 gives an internal conversation no lifecycle
    state, which is how this page tells the two apart — and a customer conversation's
    participants are decided by ownership and routing (§21.7), not by a colleague picking
    people out of a directory.
  */
  /**
   * An optimistic row stops being shown the moment its real message arrives.
   *
   * The composer owns `pending` and clears an entry when its POST returns. But the realtime
   * event can land FIRST — the server has committed and broadcast before the response has
   * travelled back — so `refetch` renders the confirmed message while the optimistic row is
   * still in flight, and for that window the sender sees their own message twice.
   *
   * The match is on `clientMessageId`, which the composer sends as the row's `localId` and
   * the server now echoes back. Matching on body text instead would collapse two genuinely
   * identical messages sent in a row, which is a thing people do.
   *
   * Filtered at RENDER rather than by clearing the composer's state: the composer still
   * owns the lifecycle, including the failed case, and two writers to one list is how a
   * retry loses its text.
   */
  const confirmedClientIds = new Set(
    messages.map((message) => message.clientMessageId).filter((id): id is string => id !== undefined),
  );
  const stillPending = pending.filter((item) => !confirmedClientIds.has(item.localId));

  const canOpenDetails = lifecycleState === undefined;
  const others = activeConversation?.participants ?? [];
  const isAnnouncement = conversationType === 'INTERNAL_ANNOUNCEMENT';
  const isGroup = !isAnnouncement && (conversationType === 'INTERNAL_GROUP' || others.length > 1);
  /* Exactly one other person, and not a broadcast: the only shape with a colleague to
     describe. `others` is empty until the summary loads, which is neither. */
  const isOneToOne = !isAnnouncement && !isGroup && others.length === 1;
  const detailsTitle = isAnnouncement ? 'Announcement' : isGroup ? 'Group info' : 'Contact info';
  /* Below four columns the panel is a sheet over the conversation rather than a column
     beside it, and only then does it carry a header of its own. */
  const panelOverlays = useMediaQuery('(max-width: 1024px)');
  const onPhone = useMediaQuery('(max-width: 640px)');

  /**
   * The composer says WHERE the message is going: "Message Riya", "Message # Ops standup".
   *
   * Screens 02 and 03 both address the placeholder, and it is the cheapest guard there is
   * against the thing this product must never do — writing into the wrong conversation. It
   * costs no pixels, it is read exactly at the moment of typing, and it names the room in
   * the same words the header does.
   *
   * A first name in a one-to-one, because that is what screen 02 draws and because a full
   * name in a two-person thread reads like a form field. The hash stays on a group: it is
   * how the whole product spells "this is a room, not a person".
   *
   * Only on an internal conversation. A customer thread's placeholder is carrying ADR-021's
   * mode — "Note for colleagues only…" versus "Reply to the customer…" — and that says
   * something a name cannot, so it wins.
   */
  const addressedPlaceholder =
    activeConversation === undefined ||
    isAnnouncement ||
    conversationType === undefined ||
    !conversationType.startsWith('INTERNAL')
      ? undefined
      : /* On a phone the field is about 200px wide and a long room name would be elided to
           nothing useful; screen 08 draws the bare word there. */
        onPhone
        ? 'Message'
        : isGroup
          ? `Message # ${conversationLabel(activeConversation)}`
          : `Message ${conversationLabel(activeConversation).split(' ')[0] ?? ''}`.trimEnd();

  /**
   * On by default where it is a column; off by default where it is a sheet.
   *
   * The design's shell is four columns at every width that can hold them, so on a wide
   * screen the header's control HIDES the panel — the opposite of what it used to do, which
   * made the designed composition the exceptional case. Below 1024px the same control
   * reveals it, because there it is covering the conversation.
   */
  /*
     The fourth column has one occupant now.

     It used to be shared with a thread pane, and "a thread wins when it is open" was the
     rule that arbitrated between them. There are no threads, so the information panel is
     simply what the column shows.
  */
  const showDetails = canOpenDetails && (panelOverlays ? overlayOpen : !columnHidden);
  const toggleDetails = (): void =>
    panelOverlays ? setOverlayOpen((was) => !was) : setColumnHidden((was) => !was);


  /**
   * May this reader post an announcement?
   *
   * Asked once when the thread turns out to be one, and never for an ordinary conversation —
   * the permission has nothing to say about those. Starts FALSE, so the first paint of an
   * announcement is the read-only one: showing a composer and then taking it away is worse
   * than showing it a beat late, and false is also the safe answer if the request fails.
   */
  const [mayAnnounce, setMayAnnounce] = useState(false);
  useEffect(() => {
    if (!isAnnouncement) {
      setMayAnnounce(false);
      return;
    }
    let live = true;
    void api
      .mayAnnounce()
      .then((result) => {
        if (live) setMayAnnounce(result.mayPost);
      })
      .catch(() => {
        if (live) setMayAnnounce(false);
      });
    return () => {
      live = false;
    };
  }, [isAnnouncement]);

  return (
    <div
      className={`thread-stage${showDetails ? ' details-open' : ' details-hidden'}`}
    >
    {/*
      `one-to-one` on the pane, so the stylesheet can drop the per-message avatar on a phone.

      Screen 08's one-to-one thread has no avatar beside a bubble: there is exactly one other
      person, the header is showing them, and 40px of the 390 spent repeating that on every
      incoming line is 40px the words could have had. A group keeps them at every width —
      there the picture is the only thing saying who is talking.
    */}
    <div className={`thread-pane${isOneToOne ? ' one-to-one' : ''}`}>
      {/*
        The header answers "who is this", which nothing on this screen used to. The
        connection state moved inside it: realtime health is a property of the conversation
        you are in, and a dedicated strip gave a rare condition permanent furniture.
      */}
      <ChatHeader
        conversation={activeConversation}
        conversationType={conversationType}
        connection={<ConnectionBadge status={status} />}
        detailsOpen={showDetails}
        onToggleDetails={canOpenDetails ? toggleDetails : undefined}
        compact={panelOverlays}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen((was) => !was)}
      />

      {/*
        SL-016 / SL-039 / SL-042 / SL-043 / SL-047 — the actions an agent can take on the
        conversation they are looking at. Every one had a guarded, tested endpoint and no
        way to be invoked from the product until 2026-08-29.

        TWO conditions, and they are not the same condition.

        `lifecycleState !== undefined` is the §21.4 test for a conversation that HAS a
        lifecycle — the exact complement of the `Participants` panel below. Correction to
        an earlier note here: this is NOT a defect fix. `ConversationActions` already
        returned `null` for a stateless conversation (see its own guard), and
        `employee-actions.spec.ts` has asserted the region is absent on an internal thread
        since before this gate existed. Gating at the call site keeps the component from
        mounting at all, which is tidier, and it is honest to say it fixed nothing.

        `showCustomerWorkspace` is the Stage 1 gate, and it is the one that matters here:
        resolve, transfer, escalate, arrange-cover and the SLA panel are customer-workspace
        controls, and Stage 1 must not present them even on a conversation that would
        legitimately carry them.
      */}
      {lifecycleState !== undefined && showCustomerWorkspace ? (
        <ConversationActions
          conversationId={conversationId}
          state={lifecycleState}
          onChanged={() => void refetch()}
        />
      ) : null}

      <div ref={scrollRef} className="thread-scroll">
        {/*
          A skeleton, not the word "Loading".

          The thread is the largest area on the screen and it used to go blank-then-full,
          which reads as a stall and then a jump. Shapes at roughly message size and
          alternating sides hold the layout still and make the wait legible as "messages
          are coming" rather than as "nothing is here". `aria-hidden` with a live region
          beside it: a screen reader wants the word, not eight empty boxes.
        */}
        {loading ? (
          <div className="thread-skeleton" aria-hidden="true">
            {[68, 44, 80, 52, 36].map((width, i) => (
              <div
                key={width}
                className={`skeleton-bubble${i % 2 === 1 ? ' mine' : ''}`}
                style={{ width: `${width}%` }}
              />
            ))}
          </div>
        ) : null}
        {loading ? (
          <p className="sr-only" role="status">
            Loading this conversation…
          </p>
        ) : null}

        {error !== undefined ? (
          <div className="thread-error">
            <p role="alert" className="state-note">
              <strong>This conversation could not be loaded</strong>
              {error}
            </p>
            <button type="button" onClick={() => void refetch()}>
              Try again
            </button>
          </div>
        ) : null}

        {!loading && error === undefined ? (
          <>
            {olderCursor !== undefined ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
                <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                </button>
              </div>
            ) : null}
            <MessageList
              onReply={setReplyingTo}
              messages={messages}
              pending={stillPending}
              currentPrincipalId={state.me.principalId}
              /* Positive test, so an unresolved kind keeps the note marking. */
              conversationIsInternal={conversationType?.startsWith('INTERNAL') === true}
              isGroup={isGroup}
              unreadOnOpen={unreadOnOpen.current}
              readWatermark={readWatermark}
              onReact={react}
              onEdit={editMessage}
              onDelete={setDeleting}
            />
          </>
        ) : null}
      </div>

      {/*
        Search inside this conversation, under the header that opened it.

        The same component the list uses, given a conversation — the server has accepted a
        conversation scope since the route was written, and nothing ever sent one.
      */}
      {/*
        Delete asks first, and asks the real question.

        "Delete for everyone" is the only option offered today because it is the only one
        the server implements: `DELETE /messages/:id` redacts the body for every reader.
        A "delete for me" needs a per-principal suppression the schema does not have, and
        an item that silently did the other thing would be worse than an absent one.
      */}
      {deleting !== undefined ? (
        <ConfirmDialog
          title="Delete message?"
          body="The text is removed for everyone in this conversation. Who sent it, and when, stays in the record."
          choices={[
            {
              label: 'Delete for everyone',
              tone: 'danger',
              onChoose: () => {
                deleteMessage(deleting);
                setDeleting(undefined);
              },
            },
          ]}
          onCancel={() => setDeleting(undefined)}
        />
      ) : null}

      {searchOpen ? (
        <div className="thread-search">
          <ConversationSearch
            conversationId={conversationId}
            conversations={activeConversation === undefined ? [] : [activeConversation]}
            onOpenConversation={() => setSearchOpen(false)}
          />
        </div>
      ) : null}

      {/*
        SL-010's typing signal, with the colleague's NAME when we already have it.

        The name used to be deliberately absent: the frame carries a principal id, and
        resolving it would have meant a directory lookup inside a component that renders on
        every keystroke. That reasoning still holds for the lookup — but the shell already
        holds the participants for this conversation, so the name is a map read against
        data that is on the page anyway. "Someone" remains the fallback for a signal from
        somebody the summary does not list, which is honest rather than a guess.

        Sits directly above the composer, which is where a chat application puts it and
        where the eye already is while waiting for a reply.
      */}
      {typing !== undefined ? (
        <p className="typing-line" aria-live="polite">
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {(activeConversation?.participants ?? []).find(
            (person) => person.principalId === typing.principalId,
          )?.displayName ?? 'Someone'}{' '}
          is {typing.visibility === 'INTERNAL' ? 'writing a note' : 'replying'}…
        </p>
      ) : null}

      {/* Not rendered until the kind is known: the composer picks its default
          visibility once, at mount, so mounting it early would leave a customer
          conversation defaulting to an internal note for the rest of the session. */}
      {/*
        An announcement is read-only for almost everybody.

        Not rendered rather than disabled: a composer that refuses on submit teaches people
        that the product is unreliable, and a disabled one still puts a text field in front
        of somebody with nothing to do with it. `decide()` refuses the send either way —
        this is the UI agreeing with the boundary, not standing in for it.
      */}
      {isAnnouncement && !mayAnnounce ? (
        <p className="thread-readonly">
          Announcements are posted by your leads. You will see replies here.
        </p>
      ) : null}

      {error === undefined && conversationType !== undefined && !(isAnnouncement && !mayAnnounce) ? (
        <Composer
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(undefined)}
          conversationId={conversationId}
          principalId={state.me.principalId}
          senderDisplayName={state.me.displayName}
          /**
           * An internal thread has no customer to reply to.
           *
           * This was hardcoded `true`, so an internal conversation opened with the
           * composer already set to "Reply to customer" and offered that mode - on a
           * thread where CUSTOMER_VISIBLE is a meaningless visibility (ADR-021) and
           * there is nobody it could reach. The absent lifecycle state is exactly how
           * this page already tells the two kinds apart (BR-23, D-15), so it decides
           * this too: on an internal thread every message is an internal one.
           */
          canReplyToCustomer={conversationType !== undefined && !conversationType.startsWith('INTERNAL')}
          {...(addressedPlaceholder !== undefined ? { placeholder: addressedPlaceholder } : {})}
          onSent={onSent}
          onPendingChange={setPending}
          onTyping={notifyTyping}
        />
      ) : null}
    </div>

    {/*
      Group info as a PLACE, not a popover.

      It used to hang off the chat header, absolutely positioned inside a 68px row: it could
      never be taller than a fraction of the screen, it floated over the messages it was
      describing, and on a phone it competed with the conversation's own name for the
      header's width. As a column it has its own header, its own scroll and its own ground,
      and the conversation simply narrows to make room — on a tablet it overlays instead,
      and on a phone it is a full-screen sheet. All three are the stylesheet's business; the
      markup is the same place at every width.

      It opens with the thing it is about: the avatar at size and the conversation's name.
      A details panel that opens with a search field is a form.
    */}
    {showDetails ? (
      <aside className="details-drawer" aria-label={detailsTitle}>
        {/*
          The panel has no header of its own in the design — it is a column, and a column
          standing beside the thread it describes needs no title bar to say so.

          It grows one only when it stops being a column. Below 1024px it overlays the
          conversation, and an overlay must be dismissible; that button is rendered at that
          width and absent at every other, rather than present-but-hidden, so the keyboard's
          tab order matches what is actually on the screen.
        */}
        {panelOverlays ? (
          <header className="details-head">
            {/*
              A back chevron before the title, not a cross after it — screen 08's phone 3.

              At this width the panel is a PAGE rather than a sheet over the conversation, and
              a page is left with a back control. The cross was the sheet's affordance and it
              sat on the wrong side of a header a thumb reaches from the left.
            */}
            <button
              type="button"
              className="details-close"
              onClick={() => setOverlayOpen(false)}
              aria-label={`Close ${detailsTitle.toLowerCase()}`}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                <path
                  d="M15 4.5 7.5 12l7.5 7.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <h2>{detailsTitle}</h2>
          </header>
        ) : null}

        <div className="details-body">
        <div className="details-identity">
          <span className={`chat-avatar${isGroup ? ' group' : ''}`} aria-hidden="true">
            {isGroup ? (
              <GroupGlyph />
            ) : activeConversation !== undefined ? (
              avatarFor(activeConversation).text
            ) : (
              '\u00b7'
            )}
          </span>
          <span className="details-identity-name">
            {activeConversation !== undefined
              ? conversationLabel(activeConversation)
              : 'Conversation'}
          </span>
          {/*
            BR-23 / D-15 in one line: an internal conversation has no case, no SLA, no queue
            and no routing, so there is nothing else true to say about it here. Saying what
            it IS beats leaving the space blank, and beats inventing a field to fill it.
          */}
          {/*
            A colleague's ROLE under their name, as screen 02 draws it. A group and an
            announcement have no role, so they keep the fact about the conversation.
          */}
          {isOneToOne ? (
            <ColleagueRole principalId={others[0]!.principalId} />
          ) : (
          <span className="details-identity-meta">
            {isAnnouncement
              ? /*
                   `participantCount` rather than the names array. That array is bounded at
                   six so a sidebar row cannot render sixty names, which makes it exactly the
                   wrong thing to count an announcement's audience with — the count is the
                   whole point of the audience, and it is the one the server maintains.
                */
                `Announcement · ${activeConversation?.participantCount ?? 0} people`
              : isGroup
                ? `${others.length + 1} members`
                : 'Direct message'}
          </span>
          )}

          {/*
            The reference's two buttons under the name: a filled primary and an outlined
            secondary.

            It draws "Message" and "Call". There is no calling in StarLink and there is not
            going to be, so the pair is "Message" — which puts the caret in the composer,
            the one thing "Message" can mean on a screen where the conversation is already
            open — and "Search", the other control screen 02 puts in this thread's header.
            Two real actions in the design's own treatment; nothing here is a picture of a
            feature.
          */}
          {isAnnouncement ? null : (
            <div className="details-identity-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const field = document.querySelector<HTMLTextAreaElement>('.composer-input');
                  field?.focus();
                }}
              >
                Message
              </button>
              <button type="button" onClick={() => setSearchOpen(true)}>
                Search
              </button>
            </div>
          )}
        </div>

        {/*
          A one-to-one gets the colleague; a group gets its membership.

          Not both, and not a compromise between them. `Participants` is the group's whole
          info experience — count, presence, add, remove, rename — and on a direct message
          it would be an invitation to turn the conversation into a group by accident. The
          directory rows are the reverse: they are one person's facts, and a group has no
          single answer to "reports to".
        */}
        {isAnnouncement ? (
          /*
             An announcement's membership is not editable, by anybody.

             Its participants are every active employee — the audience is what makes it an
             announcement — so an "add a colleague" field would be offering to add somebody
             who is already there, and a remove control would be offering to take a colleague
             off a company-wide notice. `decide()` refuses both (announcements are not in
             `PARTICIPANT_MANAGED_TYPES`); this says so instead of asking.
          */
          <section className="details-section">
            <h3 className="details-section-title">Audience</h3>
            <p className="details-empty">
              Everyone at CoverYou. People who joined after this was posted are not included.
            </p>
          </section>
        ) : (
          <>
            {/*
              A one-to-one gets the colleague's own facts; a group has no single answer to
              "reports to", so it gets nothing here.
            */}
            {isOneToOne ? <EmployeeDetails principalId={others[0]!.principalId} /> : null}

            {/*
              ONE `Participants`, at one position in the tree, whichever kind of thread this
              is — only `addOnly` changes.

              It used to be two: a full one in the group branch and an add-only one nested in
              a fragment beside the colleague's details. Adding a third person turns a
              one-to-one into a group, so the add moved the component from one branch to the
              other, React remounted it, and the confirmation it had just been given —
              "E2E Colleague was added, they can now read 4 earlier messages" — vanished in
              the same frame it appeared. BR-07's whole point is that the person is told what
              their click exposed, and they were told for about 16 milliseconds.

              On a one-to-one the member list and the rename are still absent: those restate
              what the panel already says, and the rename is refused by the server. What
              stays is the add, because it is a capability and the only place it starts.
            */}
            <Participants
              conversationId={conversationId}
              addOnly={isOneToOne}
              onChanged={() => {
                // Both: the messages gain a membership note, and the SUMMARY gains a
                // participant — which is what the header above is named from.
                void refetch();
                refreshConversations();
              }}
            />
          </>
        )}

        {/*
          Shared files last, and keyed on the message count.

          Last because it grows without bound while everything above it is fixed — and
          keyed on the count because that is the cheapest true signal that something may
          have been attached since the panel opened. It over-fetches on a plain text
          message, which is one request against a covering index; the alternative is a
          list that silently omits the file somebody just sent.
        */}
        <SharedFiles conversationId={conversationId} revision={messages.length} />

        {/*
          The design's last section. It draws two switches; there is one, and
          `ConversationControls` says why the other is absent rather than unbuilt.

          Drawn from the SUMMARY the shell already holds, so opening the panel costs no extra
          request and the switch cannot disagree with the list it sorts.
        */}
        {activeConversation !== undefined ? (
          <ConversationControls
            conversationId={conversationId}
            pinned={activeConversation.pinned}
            onChanged={refreshConversations}
          />
        ) : null}
        </div>
      </aside>
    ) : null}
    </div>
  );
}

/**
 * Connection state is shown, never hidden. If realtime is down the thread still works
 * — it just is not live — and the person deciding something from this screen deserves
 * to know which of those they are looking at.
 */
function ConnectionBadge({ status }: { status: string }): ReactNode {
  const label: Record<string, string> = {
    CONNECTING: 'Connecting…',
    LIVE: 'Live',
    RECONNECTING: 'Reconnecting — showing last loaded messages',
    OFFLINE: 'Offline — refresh to see new messages',
  };

  /**
   * The colour a DEGRADED state takes. Healthy has none, because it draws nothing at all —
   * see below.
   *
   * The history is worth keeping: this was a filled grey pill reading "● Live" beside the
   * name of the person you are talking to, then a small green dot, and now nothing. Each
   * step made the condition that holds 99% of the time quieter, and the last one is what the
   * design actually draws.
   */
  const tone = status === 'OFFLINE' ? 'down' : status === 'CONNECTING' ? '' : 'degraded';
  const text = label[status] ?? status;

  /*
     Healthy draws NOTHING, and still says so.

     It was a small green dot, permanently, in a header the reference draws with three
     controls and no indicator — a fourth element the design does not have, reporting the
     condition that holds almost all the time. The messages arriving are the indicator.

     The state is still announced: an `sr-only` live region with no box, because a screen
     reader has no "the messages are arriving" to go on. Every other state keeps its words,
     its colour and its place, because a degraded connection is the one somebody has to be
     told about.
  */
  if (status === 'LIVE') {
    return (
      <span className="sr-only" aria-live="polite">
        {text}
      </span>
    );
  }

  return (
    <span
      aria-live="polite"
      className={`realtime-status${tone === '' ? '' : ` ${tone}`}`}
      title={text}
    >
      {text}
    </span>
  );
}

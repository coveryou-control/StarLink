'use client';

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

import type { ConversationSummary } from '../lib/api-client';

/**
 * The conversation the thread pane is showing, shared from the shell that already loaded it.
 *
 * ## Why a context rather than a fetch
 *
 * The thread page needs to name the conversation in its header — "Priya Nair", not
 * "Direct message". It has the id and the message page, and the message page carries no
 * participant names. The shell one level up already holds the full summary for every
 * conversation in the sidebar, including the participants the list is named from.
 *
 * So the choice was: fetch the same data a second time from the thread, add participants
 * to the message-page response, or pass down what is already in memory. The third costs
 * nothing, adds no request and no backend change, and cannot disagree with the sidebar —
 * a header and a list row showing different names for one conversation is the kind of
 * small wrongness that makes a product feel unreliable.
 *
 * `undefined` is a real state and callers must handle it: the shell's list is paged, so a
 * conversation opened by deep link may genuinely not be in it yet.
 */
interface ActiveConversationValue {
  readonly conversation: ConversationSummary | undefined;
  /**
   * Every conversation the shell has loaded.
   *
   * Added for forwarding, which needs somewhere to forward TO. The alternative was a
   * second fetch of a list the shell already holds — two sources for one set of facts,
   * which is how a dialog ends up offering a conversation the sidebar has since dropped.
   *
   * Paged, like the sidebar: a conversation further back than "Load older" has reached is
   * genuinely not here. That is the same limitation the sidebar has and the same one the
   * forward dialog's own search box works within.
   */
  readonly conversations: readonly ConversationSummary[];
  /**
   * Re-reads the shell's conversation list.
   *
   * The thread needs this because the summary is the source of its own header. Adding a
   * colleague turns a direct message into a group, and until the list is re-read the
   * header goes on showing the one person it used to be — a conversation with three
   * people in it, titled after one of them, immediately after you watched yourself add
   * the third. The thread's own `refetch` cannot fix that: it reads messages, and the
   * participants live on the summary.
   */
  readonly refreshConversations: () => void;
}

const ActiveConversationContext = createContext<ActiveConversationValue>({
  conversation: undefined,
  conversations: [],
  refreshConversations: () => undefined,
});

export function ActiveConversationProvider({
  conversation,
  conversations,
  refreshConversations,
  children,
}: {
  readonly conversation: ConversationSummary | undefined;
  readonly conversations: readonly ConversationSummary[];
  readonly refreshConversations: () => void;
  readonly children: ReactNode;
}): ReactNode {
  /**
   * Memoised on both members. Without it the context value is a new object every render
   * of the shell — which is every keystroke in the sidebar search — and every consumer
   * re-renders with it, including the open thread.
   */
  const value = useMemo(
    () => ({ conversation, conversations, refreshConversations }),
    [conversation, conversations, refreshConversations],
  );

  return (
    <ActiveConversationContext.Provider value={value}>
      {children}
    </ActiveConversationContext.Provider>
  );
}

export function useActiveConversation(): ConversationSummary | undefined {
  return useContext(ActiveConversationContext).conversation;
}

export function useRefreshConversations(): () => void {
  return useContext(ActiveConversationContext).refreshConversations;
}

/** Every conversation the shell has loaded — for choosing one, not for rendering the list. */
export function useLoadedConversations(): readonly ConversationSummary[] {
  return useContext(ActiveConversationContext).conversations;
}

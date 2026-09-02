'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { AppRail, RAIL_SECTIONS, type RailSection } from '../../components/app-rail';
import { useMediaQuery } from '../../lib/use-media-query';
import { AnnouncementsPanel } from '../../components/announcements-panel';
import { ConversationList } from '../../components/conversation-list';
import { ConversationSearch } from '../../components/conversation-search';
import { NotificationsPanel } from '../../components/notifications-panel';
import { SettingsPanel } from '../../components/settings-panel';
import { StartConversation } from '../../components/start-conversation';
import { TeamQueue } from '../../components/team-queue';
import { TeamLoadPanel } from '../../components/team-load';
import { Directory } from '../../components/directory';
import { BrandMark } from '../../components/brand';
import { useSession } from '../../components/session-provider';
import { api, ApiError, type ConversationSummary } from '../../lib/api-client';
import { customerWorkspaceEnabled } from '../../lib/runtime-origins';
import { watchSystemTheme } from '../../lib/theme';
import { onShellAction, requestNewConversation } from '../../lib/shell-actions';
import { useNotifications } from '../../lib/use-notifications';
import { usePresence } from '../../lib/use-presence';
import { PresenceProvider } from '../../components/presence';
import { ActiveConversationProvider } from '../../components/active-conversation';

export default function WorkspaceLayout({ children }: { children: ReactNode }): ReactNode {
  const { state, signOut } = useSession();
  const router = useRouter();
  const params = useParams<{ id?: string }>();

  const [conversations, setConversations] = useState<readonly ConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  /**
   * Which rail destination is open.
   *
   * Component state rather than a route, deliberately. The thread is the route — opening a
   * conversation from People or from Notifications must not lose the conversation you are
   * reading, and a URL encoding both would make every navigation a decision about the
   * other half of the screen. The rail switches the PANEL; the thread stays put.
   */
  const [section, setSection] = useState<RailSection>('chats');

  /**
   * The announcements the panel has loaded, held here rather than only there.
   *
   * Not a second fetch: the panel loads them and hands them up. The shell needs them for
   * one thing — naming the thread column when the open conversation is an announcement.
   */
  const [announcements, setAnnouncements] = useState<readonly ConversationSummary[]>([]);

  /* The one width question the MARKUP asks. Everything else responsive is the stylesheet's. */
  const onPhone = useMediaQuery('(max-width: 640px)');

  /* Only consulted on a phone, where the search field sits behind the masthead's magnifier. */
  const [searchOpen, setSearchOpen] = useState(false);
  /* True while the search field is showing a result surface — see `ConversationSearch`. */
  const [searching, setSearching] = useState(false);

  /**
   * Read per render rather than at module scope: the injected config script and this
   * bundle have no guaranteed evaluation order, and a module-scope read would capture the
   * default permanently. Same reasoning as `runtimeOrigins`.
   */
  const showCustomerWorkspace = customerWorkspaceEnabled();

  const signedInId = state.status === 'SIGNED_IN' ? state.me.principalId : '';
  /**
   * Held in the shell so the rail badge and the notifications panel cannot disagree — two
   * pollers with two ideas of the unread count is how a badge stops being believed.
   */
  const notifications = useNotifications(signedInId);

  /**
   * Presence for everybody currently on screen, asked once for the whole surface.
   *
   * The set is drawn from the conversation list, which is what the sidebar and the chat
   * header are named from. The directory adds its own results on top — a colleague you
   * have never spoken to has no row here — so `PeoplePresence` extends it locally rather
   * than this list trying to anticipate a search nobody has typed yet.
   */
  const listedPrincipals = useMemo(
    () => conversations.flatMap((c) => (c.participants ?? []).map((participant) => participant.principalId)),
    [conversations],
  );
  const online = usePresence(listedPrincipals);

  /**
   * The conversation the thread pane is showing, handed down so its header can name it.
   *
   * `undefined` is a real answer: the list is paged, so a deep link can land on a
   * conversation this page has not loaded. The header falls back rather than blocking.
   */
  /*
     Both lists, because the thread column shows either.

     Announcements are excluded from the chat list on the server — see the panel for why —
     so a lookup in `conversations` alone leaves an open announcement unnamed. They are
     searched second: an id can only be in one of the two, and the chat list is the common
     case.
  */
  const activeConversation =
    conversations.find((c) => c.conversationId === params.id) ??
    announcements.find((c) => c.conversationId === params.id);

  useEffect(() => {
    if (state.status === 'SIGNED_OUT') router.replace('/sign-in');
  }, [state.status, router]);

  /* "Match system" is a live subscription, not a one-off read — see `theme.ts`. Mounted
     here rather than in Settings, because it has to keep working while Settings is shut. */
  useEffect(() => watchSystemTheme(), []);

  /* The empty pane's two calls to action. It is a route, so it cannot reach this state by
     prop — see `shell-actions.ts` for why an event and not a context. */
  useEffect(
    () =>
      onShellAction({
        onBrowseDirectory: () => setSection('people'),
        /* The event carries a string; the rail's own list is what decides whether it names
           a destination. An unknown one is ignored rather than setting a section that does
           not render — the same shape as rule 4, one level down. */
        onOpenSection: (section) => {
          if (RAIL_SECTIONS.includes(section as RailSection)) setSection(section as RailSection);
        },
      }),
    [],
  );

  /**
   * An empty inbox and an unreachable server must not look the same.
   *
   * This had `try/finally` and no `catch`, so a network failure or a 401 rejected into the
   * void, `loading` went false, and the list rendered "Nothing here yet." — telling an
   * agent there is no work when the truth is that nobody knows. On a 401 it also never
   * reached the session provider, so a revoked employee sat on an empty workspace instead
   * of being returned to sign-in.
   *
   * `team-queue.tsx` states the same rule for the queue and has always obeyed it; the
   * agent's own inbox, which is the primary find-work surface, did not.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.conversations();
      /**
       * Stage 1 shows internal threads only.
       *
       * The endpoint is the employee's OWN inbox rather than a customer endpoint, so this
       * adds no customer query — it declines to render a kind of conversation the stage
       * does not include. In Stage 1 none should exist anyway: no customer flow runs, so
       * anything of this kind is left over from Stage 2 testing.
       *
       * The trade-off, stated rather than buried: if an employee genuinely owned a
       * customer conversation, this would hide it from their inbox. That is the right
       * behaviour for a stage whose whole premise is that customer work is not happening,
       * and it is one flag away from being restored — but it IS a real trade-off, not a
       * free one.
       */
      setConversations(
        showCustomerWorkspace
          ? page.conversations
          : page.conversations.filter((c) => c.conversationType.startsWith('INTERNAL')),
      );
      setNextCursor(page.nextCursor);
      setLoadError(undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthenticated) {
        // The session has gone. Sign-in is the honest destination, not an empty list.
        router.replace('/sign-in');
        return;
      }
      setLoadError('Your conversations could not be loaded. This is not the same as having none.');
    } finally {
      setLoading(false);
    }
  }, [router, showCustomerWorkspace]);

  /**
   * Appends the next page. Deduplicated by id because a conversation can move to the
   * top between two requests and would otherwise appear twice — keyset paging is
   * stable against inserts, not against rows being reordered under it.
   */
  const loadMore = useCallback(async () => {
    if (nextCursor === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.conversations({ cursor: nextCursor });
      setConversations((current) => {
        const seen = new Set(current.map((c) => c.conversationId));
        return [...current, ...page.conversations.filter((c) => !seen.has(c.conversationId))];
      });
      setNextCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  useEffect(() => {
    if (state.status === 'SIGNED_IN') void refresh();
  }, [state.status, refresh]);

  if (state.status !== 'SIGNED_IN') {
    return <p style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</p>;
  }

  return (
    <PresenceProvider online={online}>
    <div
      className="app-shell"
      data-section={section}
      /* The bottom bar on a phone hides behind an open conversation — the composer needs
         the height and the chat header's back control is the way out. The attribute is on
         the shell as well as the body because the bar is the shell's child, not the
         body's. */
      data-thread-open={params.id !== undefined ? 'true' : 'false'}
    >
      {/*
        A navigation rail, one panel, one thread.

        The shell used to be a page header plus a single column holding six unrelated
        panels at once. Nothing said which of them was the product; the conversation list,
        which is, got whatever height the others left it. The rail makes the hierarchy
        structural rather than a matter of spacing.
      */}
      <AppRail
        /*
           Which shape the bar takes, decided here so the shell and the bar cannot disagree.
           640px is where the reference stops being a rail beside the page and becomes a bar
           under it — see `app-rail.tsx` for which four destinations survive the change and
           where the other two go.
        */
        layout={onPhone ? 'bottom' : 'rail'}
        active={section}
        onSelect={setSection}
        unreadNotifications={notifications.unread}
        displayName={state.me.displayName}
        onSignOut={() => void signOut()}
      />

      {/*
        `data-thread-open` is what makes this a chat app on a phone rather than a shrunken
        desktop. At narrow widths the panel and the thread cannot share the screen, so
        exactly one of them owns it: the panel when nothing is selected, the thread when
        something is. The stylesheet reads this attribute; the back control lives in the
        chat header.
      */}
      {/*
        Settings spans the whole body rather than sitting in the conversation column.

        Screen 07 draws it as a 932px surface with its own 240px nav — not a panel — and
        that is also the only arrangement that fits: rows of label, description and switch
        do not read in a third of a laptop's width. The rail stays, so the way out is the
        same way in.
      */}
      {section === 'settings' ? (
        <div className="app-body app-body-full">
          <SettingsPanel displayName={state.me.displayName} compact={onPhone} />
        </div>
      ) : (
      <div className="app-body" data-thread-open={params.id !== undefined ? 'true' : 'false'}>
        <aside className="sidebar">
          {section === 'chats' ? (
            <section className="panel" aria-label="Chats">
              <header className="panel-head">
                {/*
                  "Chats", at 20/600 — the reference's own masthead.

                  It said "Starlink" for a while, on the reasoning that a masthead is where
                  a product's name goes. The design disagrees and it is the source of truth:
                  the name lives on the rail's mark, which is on screen beside this at every
                  width that has a rail, and the column says what the column holds. On a
                  phone, where there is no rail, the mark comes back beside it — see the
                  mobile masthead below.
                */}
                <h2 className="panel-title">
                  {onPhone ? <BrandMark size={30} /> : null}
                  Chats
                </h2>
                {/*
                  Compose, in the masthead. Screen 02 puts a + here; screen 08 puts one here
                  AND a floating one at the foot of the list. Same element, and the
                  stylesheet gives it the floating treatment below 640px — the masthead's
                  phone twin is the button after the magnifier.
                */}
                <StartConversation
                  onStarted={(id) => {
                    void refresh();
                    router.push(`/conversations/${id}`);
                  }}
                />

                {/*
                  Search, on a phone, behind a magnifier.

                  Screen 08's masthead is two icon buttons and no search field: the phone
                  gives the list every row it can, and a field that is empty nine visits out
                  of ten is a row spent on nothing. At the rail widths the field is always
                  there, exactly as screen 02 draws it.
                */}
                {onPhone ? (
                  <>
                    <button
                      type="button"
                      className="panel-head-icon"
                      onClick={() => setSearchOpen((was) => !was)}
                      aria-expanded={searchOpen}
                      aria-label="Search"
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
                        <path
                          d="m15.6 15.6 4 4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>

                    {/*
                      The masthead's own +, beside the magnifier — screen 08 draws both, and
                      the floating one as well.

                      It is not a second feature: it dispatches the same shell action the
                      floating button and the empty pane's "New chat" dispatch, so there is
                      one dialog and one piece of state behind three ways in. The reason the
                      phone has two is reach — the masthead one is where the eye goes, the
                      floating one is where the thumb is.
                    */}
                    <button
                      type="button"
                      className="panel-head-icon"
                      onClick={requestNewConversation}
                      aria-label="New conversation"
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path
                          d="M12 5v14M5 12h14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </>
                ) : null}

              </header>

              {/*
                SL-081. Message search, at the TOP of the panel.

                It used to sit at the very foot of the sidebar: below the conversation list,
                below the directory, below the Stage 2 queue — the last thing on a column
                that scrolls. Search is the fastest route to a conversation whose name you
                cannot remember, and a route nobody can find is not a route.

                It lives in Chats rather than in every section because that is what it does:
                it finds a MESSAGE and takes you to the conversation holding it. People and
                Notifications have their own ways in.
              */}
              {onPhone && !searchOpen ? null : (
                <ConversationSearch
                  conversations={conversations}
                  onSearchingChange={setSearching}
                  onOpenConversation={(id) => {
                    setSection('chats');
                    router.push(`/conversations/${id}`);
                  }}
                />
              )}

              {/*
                In Stage 1 the panel body does not scroll — the LIST inside it does, so the
                search field and the filter pills stay put while you look for something.
                Stage 2 adds a queue and a load table below the list, and those genuinely
                need the whole column to scroll, so the class is conditional rather than
                a promise the customer workspace would break.
              */}
              <div className={`panel-body${showCustomerWorkspace ? '' : ' chats-body'}`}>
                {/*
                  Rendered ABOVE the list, not instead of it: a stale list plus an explicit
                  "this did not load" is more useful than either alone, and §34.4's rule is
                  that a failure is stated rather than shown as an absence.
                */}
                {loadError !== undefined ? (
                  <p role="alert" className="result-note result-note-error">
                    {loadError}
                  </p>
                ) : null}

                {/*
                  The list steps aside for the result surface — see `onSearchingChange`.

                  Not mounted, rather than hidden: the list polls and pages, and a list
                  behind a search is a list nobody can see doing it.
                */}
                {searching ? null : (
                  <ConversationList
                    currentPrincipalId={state.me.principalId}
                    conversations={conversations}
                    activeId={params.id}
                    loading={loading}
                    loadingMore={loadingMore}
                    onLoadMore={nextCursor !== undefined ? () => void loadMore() : undefined}
                  />
                )}

                {/*
                  SL-006's "no invisible waiting". One queue per team the person belongs to —
                  the API authorizes `queue.read` per team, so showing a team they are not in
                  would render a permanent refusal rather than a queue.
                */}
                {/*
                  STAGE 2 ONLY — the customer queue.
                  Not rendered in Stage 1, which means not mounted and therefore not polling
                  `/queues/:teamId`. Hiding it with CSS would leave the dependency in place,
                  and "the employee app does not depend on customer flows" would stop being
                  true. Preserved intact for Stage 2: `SL_CUSTOMER_WORKSPACE_ENABLED=true`.
                */}
                {showCustomerWorkspace
                  ? state.me.teams.map((team) => (
                      <TeamQueue
                        key={team.teamId}
                        teamId={team.teamId}
                        onOpenConversation={(id) => {
                          router.push(`/conversations/${id}`);
                          void refresh();
                        }}
                      />
                    ))
                  : null}
                {/* STAGE 2 ONLY — team workload over customer conversations. Same reasoning. */}
                {showCustomerWorkspace
                  ? state.me.teams.map((team) => (
                      <TeamLoadPanel key={`load-${team.teamId}`} teamId={team.teamId} />
                    ))
                  : null}
              </div>
            </section>
          ) : null}

          {section === 'people' ? (
            <section className="panel" aria-label="People">
              <header className="panel-head">
                <h2>People</h2>
              </header>
              <div className="panel-body">
                {/*
                  FR-DIR-*. A row here starts the conversation; `refresh` so the new thread
                  appears in Chats rather than only after the next load.

                  Finding a colleague and finding a message you half-remember are different
                  questions, and they are now in different places — the sidebar used to ask
                  both at once, in two identical-looking boxes stacked on each other.
                */}
                <Directory
                  onOpenConversation={(id) => {
                    setSection('chats');
                    router.push(`/conversations/${id}`);
                    void refresh();
                  }}
                />
              </div>
            </section>
          ) : null}

          {/*
            Announcements: the same relation, a different destination.

            `onOpen` moves the reader into the thread column and leaves the panel where it
            is, exactly as People and Notifications do — the rail switches the PANEL and the
            thread stays put.
          */}
          {section === 'announcements' ? (
            <AnnouncementsPanel
              onLoaded={setAnnouncements}
              activeId={params.id}
              onOpen={(id) => {
                router.push(`/conversations/${id}`);
                void refresh();
              }}
            />
          ) : null}

          {section === 'notifications' ? (
            <NotificationsPanel
              state={notifications}
              conversations={conversations}
              onOpenConversation={(id) => {
                setSection('chats');
                router.push(`/conversations/${id}`);
              }}
            />
          ) : null}



        </aside>

        {/*
          `key` on the conversation id, so opening a different thread REMOUNTS the page
          rather than reusing it.

          Without it Next reuses the same component instance across `[id]` changes, and
          three pieces of state survive that nothing resets: the composer's staged
          attachments (a file uploaded against one conversation stays chipped in the next,
          and the send then reports it as not attached), its pending sends (a failed send's
          text renders inside a different customer's thread), and `replyingTo` (a stale
          pointer the server correctly refuses, which the composer reports to the agent as
          "This conversation is no longer available to you" — a revocation message for a
          client-side bug).

          A remount is the honest default here: a thread page holds nothing worth carrying
          between two different conversations.
        */}
        <main key={params.id ?? 'none'} className="thread-column">
          <ActiveConversationProvider
            conversation={activeConversation}
            refreshConversations={() => void refresh()}
          >
            {children}
          </ActiveConversationProvider>
        </main>
      </div>
      )}
    </div>
    </PresenceProvider>
  );
}

'use client';

/**
 * Channels — the directory, and the way into a room.
 *
 * ## Why this is a directory and not a list of conversations
 *
 * Every other panel in this sidebar lists threads you are already in. This one lists rooms
 * that EXIST, most of which you are not in, and that difference drives everything about it:
 * the rows carry a member count rather than a last message, the grouping is by what the
 * room is for rather than by recency, and a row you cannot read is still a row — because
 * "there is a Technology channel and you are not in it" is the fact that makes joining
 * something a person can ask for instead of guess at.
 *
 * ## Every permission on screen came from the server
 *
 * `mayRead`, `mayPost`, `mayJoin` and `mayManage` are read off the response. Nothing here
 * derives them from the three policy enums, and it would be easy to: `postAccess === 'ADMINS'
 * && membership !== 'ADMIN'` looks like the whole rule and is not. Deriving it would be
 * re-implementing `decide()` in a second language, which is the divergence §38 records as
 * the reference platform's defect — and the copy that drifts is always the one on screen,
 * because it is the one nobody tests.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api, ApiError, type ChannelSummary } from '../lib/api-client';
import { ChannelDialog } from './channel-dialog';

/**
 * The four tabs, and what each of them means.
 *
 * "Departments" and "Teams" are the channel's own stated PURPOSE, not a guess from its
 * audience: a room can be scoped to three departments and still be a project. The purpose
 * is what its author said it was for, and it decides nothing but which heading it sits
 * under.
 */
type Tab = 'all' | 'mine' | 'departments' | 'teams';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'My Channels' },
  { id: 'departments', label: 'Departments' },
  { id: 'teams', label: 'Teams' },
];

/** The heading a channel sits under in the grouped view. */
const SECTION_LABEL: Readonly<Record<ChannelSummary['purpose'], string>> = {
  DEPARTMENT: 'Departments',
  TEAM: 'Teams / Projects',
  PROJECT: 'Teams / Projects',
  OTHER: 'Other',
};

/** The order those headings appear in. */
const SECTION_ORDER: readonly string[] = ['Departments', 'Teams / Projects', 'Other'];

/**
 * One line saying who this room is for, from the three enums.
 *
 * A SUMMARY, not a permission check — it describes the policy, it does not evaluate it.
 * The evaluation arrived with the row.
 */
export function accessSummary(channel: ChannelSummary): string {
  const who =
    channel.visibility === 'EVERYONE' ? 'Everyone in the company'
    : channel.visibility === 'DEPARTMENTS' ? 'Selected departments and teams'
    : 'Selected people';
  const read = channel.readAccess === 'ANYONE_WHO_CAN_SEE' ? 'anyone who can see it' : 'members only';
  const post =
    channel.postAccess === 'ANYONE_WHO_CAN_READ' ? 'anyone who can read it'
    : channel.postAccess === 'MEMBERS' ? 'members'
    : 'admins';
  return `${who} · read: ${read} · post: ${post}`;
}

/** The hash that marks a channel, drawn rather than typed so it keeps its weight. */
function ChannelGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path
        d="M9.4 4 7.8 20M16.2 4l-1.6 16M4.6 9h15M3.8 15h15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChannelsPanel({
  activeId,
  onOpen,
  onLoaded,
}: {
  readonly activeId?: string | undefined;
  readonly onOpen: (conversationId: string) => void;
  /**
   * Handed up so the thread column can NAME what it is showing.
   *
   * The chat header reads from the conversation summaries the shell holds, and that list
   * deliberately excludes channels — the same arrangement announcements already use. Without
   * this an open channel renders as "Conversation" with a dot for an avatar.
   */
  readonly onLoaded?: (channels: readonly ChannelSummary[]) => void;
}): ReactNode {
  const [channels, setChannels] = useState<readonly ChannelSummary[] | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [mayCreate, setMayCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState<string | undefined>();

  const load = useCallback(async (): Promise<readonly ChannelSummary[] | undefined> => {
    try {
      const page = await api.channels();
      setChannels(page.channels);
      onLoaded?.(page.channels);
      setProblem(undefined);
      return page.channels;
    } catch (cause) {
      /* An empty directory and an unreachable server must not look the same — the rule the
         inbox and the announcements board both obey. "No channels yet" is a fact; a failed
         request is not. */
      setChannels(undefined);
      setProblem(
        cause instanceof ApiError && cause.isUnauthenticated
          ? 'Your session has ended. Sign in again to see channels.'
          : 'Channels could not be loaded. This is not the same as none.',
      );
      return undefined;
    }
    /* Deliberately empty. `onLoaded` is a fresh closure every render in the shell, so
       depending on it would reload the directory on every parent render - and the shell
       renders on every keystroke in the search field above it. */
  }, []);

  useEffect(() => {
    void load();
    void api
      .mayCreateChannel()
      // Fail CLOSED: a permission we could not read is not a permission held.
      .then((result) => setMayCreate(result.mayCreate))
      .catch(() => setMayCreate(false));
  }, [load]);

  const join = async (channel: ChannelSummary): Promise<void> => {
    setJoining(channel.conversationId);
    try {
      await api.joinChannel(channel.conversationId);
      await load();
      onOpen(channel.conversationId);
    } catch {
      setProblem('That channel could not be joined. Nothing has changed.');
    } finally {
      setJoining(undefined);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (channels ?? [])
      .filter((c) => (tab === 'mine' ? c.membership !== 'NONE' : true))
      .filter((c) =>
        tab === 'departments' ? c.purpose === 'DEPARTMENT'
        : tab === 'teams' ? c.purpose === 'TEAM' || c.purpose === 'PROJECT'
        : true,
      )
      .filter(
        (c) =>
          needle === '' ||
          c.name.toLowerCase().includes(needle) ||
          (c.description ?? '').toLowerCase().includes(needle),
      );
  }, [channels, tab, query]);

  /*
     Grouped under headings, except on "My Channels".

     A person's own rooms are a short list they already know; splitting five of them across
     three headings is structure for its own sake. The other tabs are a directory being
     browsed, where the heading is how you find the thing you did not know the name of.
  */
  /**
   * Yours first, then the organisation.
   *
   * Grouping was purely by purpose, so the four channels somebody is actually in were
   * scattered through seventeen they are not — a directory sorted by how the company is
   * arranged rather than by what this person does all day. "Your channels" is the section
   * that answers the first question anybody opens this panel with.
   *
   * Not on the "My channels" tab, where every row is yours and a heading saying so is a
   * label on the whole list. Not on a SEARCH either: a search has one answer set and
   * cutting it into four makes a short list look like an empty one.
   */
  const grouped = useMemo(() => {
    if (tab === 'mine') return [{ heading: undefined, rows: visible }];
    if (query.trim() !== '') return [{ heading: undefined, rows: visible }];

    const mine = visible.filter((channel) => channel.membership !== 'NONE');
    const rest = visible.filter((channel) => channel.membership === 'NONE');

    const byHeading = new Map<string, ChannelSummary[]>();
    for (const channel of rest) {
      const heading = SECTION_LABEL[channel.purpose];
      const bucket = byHeading.get(heading);
      if (bucket === undefined) byHeading.set(heading, [channel]);
      else bucket.push(channel);
    }
    const sections = SECTION_ORDER.filter((heading) => byHeading.has(heading)).map((heading) => ({
      heading,
      rows: byHeading.get(heading) ?? [],
    }));
    return mine.length > 0 ? [{ heading: 'Your channels', rows: mine }, ...sections] : sections;
  }, [visible, tab, query]);

  return (
    <section className="panel" aria-label="Channels">
      {/*
        A masthead that says what this place IS.

        "Channels" alone is a word somebody has to already know. A channel is not another
        kind of group chat, and the difference — persistent, organised around a team or a
        topic, with its own access rules — is exactly what a person meeting the section for
        the first time has no way to infer from a list of names. One line, once, at the top
        of the thing it describes.
      */}
      <header className="panel-head channels-head">
        <span className="channels-head-text">
          <h2>Channels</h2>
          <p>Persistent spaces for departments, teams and projects.</p>
        </span>
        {mayCreate ? (
          <button
            type="button"
            className="panel-head-action channels-create"
            onClick={() => setCreating(true)}
            aria-label="Create a channel"
            title="Create a channel"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
              <path d="M12 5.5v13M5.5 12h13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
            Create
          </button>
        ) : null}
      </header>

      <div className="search">
        <label className="visually-hidden" htmlFor="channel-search">
          Search channels
        </label>
        <input
          id="channel-search"
          type="search"
          value={query}
          placeholder="Search channels…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="filter-pills" role="tablist" aria-label="Which channels">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`filter-pill${tab === entry.id ? ' active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {problem !== undefined ? (
        <p className="state-note" role="alert">
          {problem}
        </p>
      ) : null}

      {channels === undefined && problem === undefined ? (
        /* A skeleton, not the word "Loading" — the same shapes the conversation list uses,
           so the two panels do not disagree about what waiting looks like. */
        <ul className="channel-items" aria-hidden="true">
          {[74, 58, 66].map((width) => (
            <li key={width}>
              <div className="channel-row skeleton-row">
                <span className="channel-mark skeleton-block" />
                <span style={{ flex: 1 }}>
                  <span className="skeleton-line" style={{ width: `${width}%` }} />
                  <span className="skeleton-line short" style={{ width: `${width - 20}%` }} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {channels !== undefined && visible.length === 0 ? (
        <p className="state-note">
          {query.trim() !== '' ? (
            <>No channel matches “{query.trim()}”.</>
          ) : tab === 'mine' ? (
            <>You are not in any channel yet. Open “All” to see what there is.</>
          ) : (
            <>No channels here yet.</>
          )}
        </p>
      ) : null}

      {grouped.map((group) => (
        <div key={group.heading ?? 'all'}>
          {group.heading !== undefined ? (
            <p className="channel-group-heading">{group.heading}</p>
          ) : null}
          <ul className="channel-items">
            {group.rows.map((channel) => (
              <li key={channel.conversationId}>
                {/*
                  The whole row opens the channel — but only when the server says this
                  person may read it. A row they may not read is not a button that fails; it
                  is a listing with a join beside it, or a line saying who to ask.
                */}
                <div
                  className={`channel-row${
                    activeId === channel.conversationId ? ' active' : ''
                  }${channel.mayRead ? '' : ' locked'}`}
                >
                  <button
                    type="button"
                    className="channel-open"
                    disabled={!channel.mayRead}
                    onClick={() => onOpen(channel.conversationId)}
                    aria-current={activeId === channel.conversationId ? 'page' : undefined}
                  >
                    <span className="channel-mark" aria-hidden="true">
                      <ChannelGlyph />
                    </span>
                    <span className="channel-text">
                      <span className="channel-name">
                        {channel.name}
                        {channel.archived ? <span className="channel-tag">Archived</span> : null}
                      </span>
                      {/*
                        The description AND the count, on two lines rather than one OR the
                        other.

                        It showed the description when there was one and the member count
                        when there was not — so the rows that said most about themselves
                        were the only ones that did not say how big they were, and a
                        channel with no description looked like a channel with two members
                        for a subtitle. They answer different questions: what is this for,
                        and how many people are in it.
                      */}
                      {channel.description !== undefined ? (
                        <span className="channel-sub">{channel.description}</span>
                      ) : null}
                      <span className="channel-facts">
                        <span>
                          {channel.memberCount} {channel.memberCount === 1 ? 'member' : 'members'}
                        </span>
                        {/* Only when it is NOT the ordinary case. A "Everyone" tag on
                            fifteen of seventeen rows is noise; a "Restricted" one on the
                            two that are is information. */}
                        {channel.visibility !== 'EVERYONE' ? (
                          <span className="channel-scope" title={accessSummary(channel)}>
                            {channel.visibility === 'DEPARTMENTS' ? 'Team only' : 'Invite only'}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {channel.unreadCount > 0 ? (
                      <span className="channel-unread" aria-label={`${channel.unreadCount} unread`}>
                        {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
                      </span>
                    ) : null}
                  </button>

                  {/*
                    Join, or an explanation. Never a disabled button with no reason beside it.

                    A members-only room cannot be self-joined — that is the deliberate
                    refusal that keeps "members only" from meaning "anyone who presses the
                    button" — so what is offered instead is the truth about how to get in.
                  */}
                  {channel.mayJoin ? (
                    <button
                      type="button"
                      className="channel-join"
                      disabled={joining === channel.conversationId}
                      onClick={() => void join(channel)}
                    >
                      {joining === channel.conversationId ? 'Joining…' : 'Join'}
                    </button>
                  ) : channel.membership === 'NONE' && !channel.archived ? (
                    <span className="channel-closed" title={accessSummary(channel)}>
                      Members only
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {creating ? (
        <ChannelDialog
          onDismiss={() => setCreating(false)}
          onSaved={(conversationId) => {
            setCreating(false);
            void load();
            onOpen(conversationId);
          }}
        />
      ) : null}
    </section>
  );
}

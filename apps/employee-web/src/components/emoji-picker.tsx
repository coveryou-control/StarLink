'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * The emoji picker.
 *
 * ## Why this is honest to build
 *
 * It adds no capability the backend does not have. An emoji is a character; inserting one
 * puts UTF-8 into the same `body` field every other character goes into, and the message
 * that results is an ordinary message. Nothing here implies a reaction, a status or a
 * notification — those would all be claims the API cannot support.
 *
 * ## Where the list comes from
 *
 * `emoji-data.generated.ts` — 1,644 emoji built from emojibase's CLDR data by
 * `scripts/generate-emoji.mjs`, with the annotations people actually search by, so the
 * field finds 🙏 for "thanks".
 *
 * It was a hand-written list of about 130 before, and that failed in both directions. It
 * was incomplete in ways nobody can predict — the emoji you want is the one somebody did
 * not think of — and it contained characters the platform could not draw: 🫡 🫠 🫶 rendered
 * as empty boxes on Windows 10, whose Segoe UI Emoji stops at Emoji 12.0.
 *
 * ## What renders them
 *
 * Noto Color Emoji, bundled with the application — see `app/emoji-font.css`. Not the
 * platform's font: the platforms disagree wildly about what an emoji looks like and
 * Windows 10 cannot draw a large part of the set at all. One bundled font means the
 * picker, the reaction strip and the message bodies all show the same artwork, on every
 * machine, offline.
 */
import { EMOJI_GROUPS as GROUPS } from './emoji-data.generated';

const RECENT_KEY = 'starlink.emoji-recent';
const RECENT_MAX = 16;

function readRecent(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // Private windows and blocked site data are not error states; there is simply no history.
    return [];
  }
}

function rememberRecent(emoji: string): readonly string[] {
  const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Nothing to do; the picker works without a history.
  }
  return next;
}

export function EmojiPicker({ onPick }: { readonly onPick: (emoji: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState(GROUPS[0]!.id);
  const [term, setTerm] = useState('');
  const [recent, setRecent] = useState<readonly string[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  // Read on open rather than on mount: localStorage is not available during the server
  // render, and the value can have changed in another tab since.
  useEffect(() => {
    if (open) setRecent(readRecent());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /**
   * Searching looks across EVERY group, not the selected one.
   *
   * A search that only searched the open tab would answer "no results" for something that
   * is two tabs away — which is the behaviour that teaches people the picker does not have
   * what they want.
   */
  const shown = useMemo(() => {
    const query = term.trim().toLowerCase();
    if (query === '') {
      return GROUPS.find((g) => g.id === group)?.emoji ?? [];
    }
    return GROUPS.flatMap((g) => g.emoji).filter(
      ([glyph, keywords]) => keywords.includes(query) || glyph === query,
    );
  }, [term, group]);

  const choose = (emoji: string): void => {
    onPick(emoji);
    setRecent(rememberRecent(emoji));
    // Closed after one pick: the common case is a single acknowledgement, and a panel that
    // stays open covers the message you are writing.
    setOpen(false);
    setTerm('');
  };

  return (
    <div className="emoji" ref={ref}>
      <button
        type="button"
        className="emoji-toggle"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label="Insert an emoji"
      >
        <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <circle cx="9.2" cy="10" r="1.1" fill="currentColor" />
          <circle cx="14.8" cy="10" r="1.1" fill="currentColor" />
          <path
            d="M8.4 14.4a4.3 4.3 0 0 0 7.2 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open ? (
        <div className="emoji-panel" role="dialog" aria-label="Emoji">
          <div className="emoji-search">
            <label>
              <span className="sr-only">Search emoji</span>
              <input
                type="search"
                value={term}
                autoFocus
                placeholder="Search"
                onChange={(event) => setTerm(event.target.value)}
              />
            </label>
          </div>

          {/* The categories. Hidden while searching, because search already spans them. */}
          {term.trim() === '' ? (
            <div className="emoji-tabs" role="tablist" aria-label="Emoji categories">
              {GROUPS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  role="tab"
                  aria-selected={group === g.id}
                  className={`emoji-tab${group === g.id ? ' active' : ''}`}
                  onClick={() => setGroup(g.id)}
                  title={g.label}
                  aria-label={g.label}
                >
                  <span className="emoji-glyph" aria-hidden="true">
                    {g.tab}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="emoji-scroll">
            {/*
              What you actually use, first.

              Sixteen slots and no more: a "recent" list long enough to scroll is a second
              full picker with worse ordering. Only on the default tab and only when there
              is a history — an empty section with a heading is furniture.
            */}
            {term.trim() === '' && group === GROUPS[0]!.id && recent.length > 0 ? (
              <>
                <p className="emoji-heading">Recent</p>
                <div className="emoji-grid">
                  {recent.map((emoji) => (
                    <button
                      key={`recent-${emoji}`}
                      type="button"
                      onClick={() => choose(emoji)}
                      aria-label={emoji}
                    >
                      <span className="emoji-glyph">{emoji}</span>
                    </button>
                  ))}
                </div>
                <p className="emoji-heading">
                  {GROUPS.find((g) => g.id === group)?.label ?? ''}
                </p>
              </>
            ) : null}

            {shown.length === 0 ? (
              <p className="emoji-empty">No emoji matches “{term.trim()}”.</p>
            ) : (
              <div className="emoji-grid">
                {shown.map(([emoji, keywords]) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => choose(emoji)}
                    // The keywords are the accessible name: "thumbs up" is what a screen
                    // reader should say, not the character itself.
                    aria-label={keywords.split(' ').slice(0, 3).join(' ')}
                    title={keywords.split(' ').slice(0, 3).join(' ')}
                  >
                    <span className="emoji-glyph">{emoji}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

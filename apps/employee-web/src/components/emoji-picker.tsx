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
 * ## Why a fixed list rather than a library
 *
 * The full Unicode set is about 1,900 characters plus skin-tone and gender variants, and
 * the data files that ship with the popular pickers run to 200KB before the component. This
 * is roughly two hundred, grouped and searchable, chosen for a workplace — which covers
 * what people actually send and adds no dependency.
 *
 * It was twenty-four in one undifferentiated grid, which is where the "not enough variety"
 * came from. The grouping is as much of the fix as the count: two hundred in one grid is
 * worse than twenty-four, and the row of category buttons is what makes the difference.
 *
 * ## What renders them
 *
 * The glyphs come from the platform's colour emoji font — Segoe UI Emoji on Windows, Apple
 * Color Emoji on macOS and iOS, Noto Color Emoji on Android and most Linux. The stack is
 * declared explicitly in `.emoji-glyph` rather than inherited, because the body font is
 * matched first for anything it happens to contain and several of these resolve to a flat
 * monochrome outline that way.
 *
 * Shipping ONE set that looks identical everywhere means bundling an emoji font, and the
 * options are worth stating: Apple's artwork (which is what a phone messenger looks like)
 * is licensed and cannot be redistributed; Noto Color Emoji is open but about 10MB; Twemoji
 * is open, ~400KB as SVGs, and needs a CC-BY attribution. That is a licensing and
 * asset-budget decision, not a styling one.
 *
 * ## Which characters are in the list, and why not the obvious ones
 *
 * Every glyph below is one that Windows 10's Segoe UI Emoji can actually DRAW, verified by
 * measuring it rather than by reading a Unicode version table. That font stops at Emoji
 * 12.0, so 🫡 🫠 🫶 🥲 render as an empty box, and it has no gender-neutral ZWJ professions,
 * so 🧑‍💻 falls apart into a person and a laptop side by side. All eight were in the first
 * draft of this list and all eight looked broken on the machine this is developed on.
 *
 * The gendered professions (👩‍💻 👨‍⚖️) DO render there, which is why they are the ones
 * present. Re-run `.local/emoji-probe.mjs` after adding anything: it reports tofu and split
 * sequences by measuring the advance against a known-missing codepoint.
 */

interface EmojiGroup {
  readonly id: string;
  /** The category button's glyph — one of the group's own members. */
  readonly tab: string;
  readonly label: string;
  readonly emoji: readonly (readonly [string, string])[];
}

/**
 * `[glyph, keywords]`. The keywords are what search matches on, so the field finds "thanks"
 * for 🙏 — nobody searches an emoji by its Unicode name.
 */
const GROUPS: readonly EmojiGroup[] = [
  {
    id: 'reactions',
    tab: '👍',
    label: 'Reactions',
    emoji: [
      ['👍', 'yes ok agree approve thumbs up good'],
      ['👎', 'no disagree thumbs down bad'],
      ['🙏', 'thanks please grateful namaste'],
      ['👏', 'clap well done bravo congratulations'],
      ['🙌', 'celebrate hooray praise'],
      ['🤝', 'deal agreed handshake partner'],
      ['✅', 'done complete tick check yes'],
      ['❌', 'no wrong cancel remove'],
      ['❤️', 'love heart'],
      ['🔥', 'fire great hot excellent'],
      ['💯', 'hundred perfect agree'],
      ['🎉', 'party celebrate launch congrats'],
      ['👌', 'ok perfect fine'],
      ['🤞', 'fingers crossed hope luck'],
      ['💪', 'strong effort push'],
      ['👊', 'on it fist bump acknowledged'],
      ['👀', 'looking eyes watching review'],
      ['🙋', 'volunteer raise hand me'],
    ],
  },
  {
    id: 'smileys',
    tab: '🙂',
    label: 'Smileys',
    emoji: [
      ['🙂', 'smile happy'],
      ['😄', 'grin happy laugh'],
      ['😁', 'beam grin teeth'],
      ['😅', 'sweat nervous laugh phew'],
      ['😂', 'laughing tears funny lol'],
      ['🤣', 'rofl hilarious'],
      ['😊', 'blush pleased warm'],
      ['😉', 'wink joking'],
      ['😍', 'love heart eyes'],
      ['😎', 'cool sunglasses'],
      ['🤔', 'thinking hmm consider'],
      ['🤨', 'suspicious doubt raised eyebrow'],
      ['😐', 'neutral flat no comment'],
      ['😬', 'grimace awkward yikes'],
      ['😴', 'sleep tired zzz'],
      ['😌', 'relieved calm fine'],
      ['😢', 'sad cry'],
      ['😞', 'disappointed down'],
      ['😤', 'frustrated steam annoyed'],
      ['🤯', 'mind blown shocked'],
      ['😱', 'scream shock panic'],
      ['🥳', 'party face celebrate'],
      ['😇', 'innocent halo'],
      ['😫', 'overwhelmed exhausted too much'],
    ],
  },
  {
    id: 'people',
    tab: '👥',
    label: 'People',
    emoji: [
      ['👩‍💻', 'working coding developer laptop'],
      ['👩‍💼', 'manager office professional'],
      ['👨‍💼', 'manager office professional'],
      ['👩‍🏫', 'training teaching explain'],
      ['🕵️', 'investigating looking into detective'],
      ['👨‍⚖️', 'legal compliance judge'],
      ['👮', 'police enforcement'],
      ['👨‍🔧', 'fixing engineer repair'],
      ['🤦', 'facepalm oh no'],
      ['🤷', 'shrug dont know unsure'],
      ['🙇', 'apology sorry bow'],
      ['🚶', 'walking heading out'],
      ['🏃', 'running rushing urgent'],
      ['👋', 'hello hi bye wave'],
      ['🤗', 'appreciate thanks hug'],
      ['🧠', 'brain idea smart think'],
      ['👥', 'team people group'],
      ['🗣️', 'speaking talking discuss'],
    ],
  },
  {
    id: 'work',
    tab: '📊',
    label: 'Work',
    emoji: [
      ['📊', 'chart report numbers data'],
      ['📈', 'up growth increase trend'],
      ['📉', 'down decrease drop loss'],
      ['📋', 'clipboard list tasks'],
      ['📝', 'note write memo'],
      ['📄', 'document file page'],
      ['📁', 'folder files'],
      ['📎', 'attachment clip file'],
      ['🗂️', 'files organise records'],
      ['📌', 'pin important pinned'],
      ['🗓️', 'calendar date schedule'],
      ['⏰', 'time deadline alarm reminder'],
      ['⏳', 'waiting pending time'],
      ['🔔', 'notify alert reminder bell'],
      ['📞', 'call phone ring'],
      ['✉️', 'email mail message'],
      ['🧾', 'receipt invoice claim bill'],
      ['🛡️', 'policy cover protection insurance'],
      ['🏦', 'bank branch office'],
      ['💰', 'money premium payment'],
      ['💳', 'card payment'],
      ['✍️', 'sign signature approve'],
      ['🔍', 'search find look up'],
      ['🗒️', 'notepad minutes'],
    ],
  },
  {
    id: 'status',
    tab: '🚦',
    label: 'Status',
    emoji: [
      ['🚦', 'status blocked go'],
      ['🟢', 'green good open available'],
      ['🟡', 'amber warning caution'],
      ['🔴', 'red blocked stopped critical'],
      ['⚠️', 'warning careful risk'],
      ['🚨', 'urgent escalate alarm critical'],
      ['🆗', 'ok fine approved'],
      ['🆕', 'new'],
      ['🔒', 'locked private confidential'],
      ['🔓', 'unlocked open'],
      ['⏸️', 'paused on hold'],
      ['▶️', 'resume start go'],
      ['🔁', 'repeat again retry'],
      ['⏭️', 'skip next'],
      ['❓', 'question unclear'],
      ['❗', 'important attention'],
      ['💤', 'idle away inactive'],
      ['🏁', 'finished done complete'],
    ],
  },
  {
    id: 'objects',
    tab: '💡',
    label: 'Objects',
    emoji: [
      ['💡', 'idea suggestion lightbulb'],
      ['⚡', 'fast quick power urgent'],
      ['⭐', 'star favourite important'],
      ['🚀', 'launch ship release fast'],
      ['🛠️', 'tools fixing work in progress'],
      ['🧩', 'piece part integration'],
      ['🔗', 'link url reference'],
      ['💻', 'laptop computer'],
      ['📱', 'phone mobile'],
      ['🖨️', 'print printer'],
      ['🗑️', 'delete bin remove'],
      ['📦', 'package delivery box'],
      ['☕', 'coffee break'],
      ['🍵', 'tea break chai'],
      ['🍽️', 'lunch food break'],
      ['🎯', 'target goal accurate'],
      ['🧭', 'direction guidance plan'],
      ['🏆', 'win award best'],
      ['🎁', 'gift bonus'],
      ['💬', 'comment chat message'],
      ['📢', 'announce broadcast notice'],
      ['🔖', 'bookmark tag label'],
    ],
  },
];

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

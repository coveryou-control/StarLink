'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { initialsFor } from './conversation-naming';
import { PresenceDot } from './presence';

export interface MentionCandidate {
  /** Absent for `@all`, which refers to the conversation rather than to a person. */
  readonly principalId?: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * The member list that opens when somebody types `@`.
 *
 * ## Keyboard first
 *
 * A mention picker is used mid-sentence, so the hands are on the keys: arrows move,
 * Enter and Tab pick, Escape closes. The mouse works too, but the keyboard is the path
 * this is designed around — a picker that requires reaching for the mouse is slower than
 * typing the name out, which is what people would go back to doing.
 *
 * ## Selection lives with the caller
 *
 * The composer owns `active`, because Enter must do different things depending on whether
 * this list is open — send the message, or pick a name — and only one component can own
 * that decision. Passing it down keeps the keyboard handling in one place instead of two
 * that have to agree.
 */
export function MentionPicker({
  candidates,
  active,
  onPick,
}: {
  readonly candidates: readonly MentionCandidate[];
  readonly active: number;
  readonly onPick: (candidate: MentionCandidate) => void;
}): ReactNode {
  if (candidates.length === 0) return null;

  return (
    <div className="mention-picker" role="listbox" aria-label="Mention a colleague">
      {candidates.map((candidate, index) => (
        <button
          key={candidate.principalId ?? 'all'}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`mention-option${index === active ? ' active' : ''}`}
          /*
            `onMouseDown` with `preventDefault`, not `onClick`. A click first blurs the
            textarea, and a blur closes the picker — so by the time `onClick` fires there
            is nothing to click. This keeps the caret where it was, which is where the
            mention has to be inserted.
          */
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(candidate);
          }}
        >
          <span className="avatar-wrap">
            <span className="row-avatar" aria-hidden="true">
              {candidate.principalId === undefined ? '@' : initialsFor(candidate.label)}
            </span>
            {candidate.principalId !== undefined ? (
              <PresenceDot principalId={candidate.principalId} />
            ) : null}
          </span>
          <span className="mention-text">
            <span className="mention-name">{candidate.label}</span>
            {candidate.hint !== undefined ? (
              <span className="mention-hint">{candidate.hint}</span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Keeps the highlighted row inside the list as it is filtered.
 *
 * Typing narrows the candidates, and an index that pointed at the fifth of six is out of
 * range once two remain — Enter would then insert nothing and the message would go out
 * with a literal "@pri" in it.
 */
export function useClampedIndex(length: number): [number, (next: number) => void] {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex((current) => (current >= length ? 0 : current));
  }, [length]);
  return [Math.min(index, Math.max(0, length - 1)), setIndex];
}

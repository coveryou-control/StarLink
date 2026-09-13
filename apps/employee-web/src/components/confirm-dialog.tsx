'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * A confirmation the product draws itself.
 *
 * ## Why not `window.confirm`
 *
 * It was one. `window.confirm` puts a Chrome-chrome alert at the TOP OF THE BROWSER, in the
 * browser's own typography, prefixed with "localhost:3010 says" — which reads as something
 * the page did to you rather than something the product is asking. It also blocks the main
 * thread, cannot be styled, cannot offer a third option, and on a phone it is a system sheet
 * that looks like a scam prompt.
 *
 * The third option is the reason it had to go: "delete" is not one question. It is "for me"
 * or "for everyone", and a two-button OS dialog cannot ask that.
 *
 * ## The dangerous choice is not the default
 *
 * `autoFocus` goes on Cancel, and Escape and the backdrop both dismiss. Somebody who opened
 * this by accident gets out by pressing the key they would press anyway, and somebody who
 * hits Enter out of habit does not destroy anything.
 */
export function ConfirmDialog({
  title,
  body,
  choices,
  onCancel,
}: {
  readonly title: string;
  readonly body?: string | undefined;
  /**
   * The actions, in the order they are drawn. `tone: 'danger'` colours one red; there is
   * deliberately no "primary", because on a destructive dialog the safe way out is the
   * primary and that is Cancel.
   */
  readonly choices: readonly {
    readonly label: string;
    readonly detail?: string;
    readonly tone?: 'danger';
    readonly onChoose: () => void;
  }[];
  readonly onCancel: () => void;
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        {body !== undefined ? <p className="muted">{body}</p> : null}

        <div className="confirm-choices">
          {choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              className={choice.tone === 'danger' ? 'confirm-danger' : undefined}
              onClick={choice.onChoose}
            >
              <span>{choice.label}</span>
              {choice.detail !== undefined ? (
                <span className="muted">{choice.detail}</span>
              ) : null}
            </button>
          ))}
          <button ref={cancelRef} type="button" className="confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** Rendered by the caller only while a confirmation is pending. */
export type PendingConfirm = Parameters<typeof ConfirmDialog>[0] extends infer P
  ? P extends { title: string }
    ? Omit<P, 'onCancel'>
    : never
  : never;

export type ConfirmChildren = ReactNode;

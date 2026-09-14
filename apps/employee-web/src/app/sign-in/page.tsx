'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { BrandMark } from '../../components/brand';
import { ConnectionField } from './connection-field';
import { useSession } from '../../components/session-provider';
import { ApiError } from '../../lib/api-client';
import { forceSignInTheme } from '../../lib/theme';

/**
 * Sign in.
 *
 * ## The composition
 *
 * A wide, quiet canvas with the form set centre-right, and a drawn field of connections
 * arriving from the right edge to converge into a single star on the left. The star is the
 * focal point and the form is the subject; they occupy different thirds so neither has to
 * compete with the other for the same glance.
 *
 * The graphic lives in `connection-field.tsx` and the reasoning about its geometry is
 * there. What matters here is that it is BEHIND everything, `aria-hidden`, and entirely
 * decorative: remove it and the page still works, still reads and still passes.
 *
 * ## What is NOT on this page
 *
 * The reference composition includes a "Sign in with Microsoft" button. There is no SSO in
 * StarLink today — the sign-in note says as much, two lines further down — so a button
 * offering it would be a control that cannot do the thing it names. It is omitted rather
 * than drawn and disabled.
 *
 * ## What survives from every earlier version
 *
 * The form itself, unchanged: the same labels the browser suite types into, the same
 * "Forgot password?" that answers rather than navigates, the same show/hide, the same
 * remember box defaulting to off, the same single error message that never distinguishes
 * a bad password from an unknown account.
 */
export default function SignInPage(): ReactNode {
  /**
   * This screen is dark, whatever the person has chosen for the workspace.
   *
   * `themeBootScript` already stamps dark before the first paint, which covers opening the
   * address or reloading. It does not cover ARRIVING here from inside the application:
   * signing out is `router.replace('/sign-in')`, a client-side navigation, so no document
   * loads and no script runs — and the page kept whatever the workspace was showing. Anybody
   * who had chosen Light saw a light sign-in screen until they hard-refreshed, which is why
   * it looked intermittent.
   *
   * A LAYOUT effect, not an ordinary one: `useEffect` runs after paint, so the light screen
   * would be visible for a frame before correcting itself — a flash is what the pre-paint
   * script exists to avoid, and reintroducing it here would fix the bug and keep the
   * symptom. Guarded for the server, where `useLayoutEffect` is meaningless and React says
   * so loudly; the boot script is what covers that path anyway.
   *
   * The cleanup restores the person's real choice, so walking back into the workspace does
   * not carry the door's palette with it.
   */
  const useOnMount = typeof window === 'undefined' ? useEffect : useLayoutEffect;
  useOnMount(() => forceSignInTheme(), []);

  const { state, signIn } = useSession();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  /**
   * Defaults to OFF, even where a reference draws it ticked.
   *
   * Ticked by default, every sign-in on every machine — including a shared branch terminal
   * — silently gets fourteen days unless somebody notices and unticks it. That is the
   * wrong direction for a default nobody reads to fall, the server route says as much in
   * its own comment, and `security-baseline.spec.ts` fails if it drifts.
   */
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    if (state.status === 'SIGNED_IN') router.replace('/conversations');
  }, [state.status, router]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await signIn(username, password, remember);
      router.replace('/conversations');
    } catch (cause) {
      // Never distinguish "no such account" from "wrong password" — that turns the
      // sign-in form into an account-enumeration oracle (doc §18.6).
      setError(
        cause instanceof ApiError && cause.status === 0
          ? 'Could not reach the server.'
          : 'Those details did not match an account.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="signin">
      <ConnectionField />

      {/* No wordmark up here any more.

          It named the product in the top-left while the star names it in the middle and the
          mark above the form names it a third time — three statements of the same fact on a
          screen with one job. The star is the identity; this was the caption nobody needed,
          and removing it also gives the composition back the top of the page. */}

      <div className="signin-stage">
        {/*
          Four words beside the star, and nothing else in this column.

          The larger "welcome" block that sat here is gone: it was marketing copy competing
          with the star for the left third, and the graphic establishes the identity on its
          own. `aria-hidden` because it says nothing a screen reader needs, and hearing the
          product named three times before reaching the form is worse, not richer.
        */}
        <aside className="signin-lede" aria-hidden="true">
          <p className="signin-tags">
            <span>People</span>
            <span>Ideas</span>
            <span>Conversations</span>
            <span>All connected</span>
          </p>
        </aside>

        {/* Card and its footnote are one column, so the note sits under the form it
            qualifies rather than under the middle of the page. */}
        <div className="signin-column">
        <div className="signin-panel">
        <header className="signin-masthead">
          <BrandMark size={40} />
          <h1>Welcome back</h1>
        </header>

        <form onSubmit={(event) => void submit(event)} className="signin-form">
          {/*
            The field names all three things it accepts, and accepts all three.

            It said "Username" first, because that is what `SL_ADAPTER_IAM=local`
            authenticates against; then "Work email", once the adapter learned to take the
            local part of an address. Both were narrower than the truth. People know
            themselves by whichever of the three their last system asked for — the
            directory lists an employee code, the mail system an address — and guessing
            wrong on the one screen nobody can get past is a support call.

            `verifyCredential` matches a username, an address's local part, or an employee
            code, case-insensitively. The label was widened only after that was true.
          */}
          <label className="signin-field">
            <span className="signin-label">Work ID or email</span>
            {/*
              Wrapped like the password field rather than left bare, and that symmetry is
              load-bearing as well as visual.

              The design system styles a bare `input[type='text']` at specificity (0,1,1),
              one step above `.signin-control` at (0,1,0) — which is how this field, and
              only this field, painted itself near-black in dark mode while its twin stayed
              white. Inside a group the input is transparent at (0,2,1) and the wrapper
              draws the surface, so both fields now get their appearance the same way and
              neither can lose that argument alone.
            */}
            {/*
              Both fields are marked, not one.

              The server never says WHICH of the two was wrong - §27.3, and deliberately:
              distinguishing them tells an attacker which usernames exist. So the interface
              must not pretend to know either. Marking both is the honest rendering of one
              refusal about a pair.
            */}
            <span
              className={`signin-control signin-control-group${error !== undefined ? ' invalid' : ''}`}
            >
              <span className="signin-adornment" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="15" height="15" focusable="false">
                  <rect
                    x="3"
                    y="5.5"
                    width="18"
                    height="13"
                    rx="2.4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  />
                  <path
                    d="m3.8 7 7.3 5.4a1.5 1.5 0 0 0 1.8 0L20.2 7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <input
                type="text"
                inputMode="email"
                autoComplete="username"
                aria-invalid={error !== undefined}
                required
                placeholder="Employee code, user ID or email"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </span>
          </label>

          <div className="signin-field">
            {/*
              The label and "Forgot password?" share a row.

              A `<label>` cannot wrap the link — a click anywhere inside a label focuses its
              control, so the link would both open the help and put the caret in the
              password box. A plain div with an explicit `htmlFor` gives the same
              association and survives having a second interactive thing on the row.
            */}
            <div className="signin-label-row">
              <label className="signin-label" htmlFor="signin-password">
                Password
              </label>
              {/*
                It ANSWERS rather than navigates.

                There is no reset flow in StarLink and there will not be one: the credential
                belongs to the directory, not to this product (rule 11). A link to a page
                that would only say that is one click of nothing, so the answer appears
                where the question is asked.
              */}
              <button
                type="button"
                className="signin-quiet"
                aria-expanded={helpOpen}
                onClick={() => setHelpOpen((was) => !was)}
              >
                Forgot password?
              </button>
            </div>

            <div
              className={`signin-control signin-control-group${error !== undefined ? ' invalid' : ''}`}
            >
              <span className="signin-adornment" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="15" height="15" focusable="false">
                  <rect
                    x="4.5"
                    y="10.5"
                    width="15"
                    height="9.5"
                    rx="2.2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  />
                  <path
                    d="M8 10.5V8a4 4 0 0 1 8 0v2.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <input
                id="signin-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                aria-invalid={error !== undefined}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {/*
                Show/hide is a security control, not a convenience: a password nobody can
                read is one typed wrong twice and then pasted from somewhere it should not
                have been written down. `aria-pressed` so a screen reader hears the state
                rather than inferring it from a word that names the opposite.
              */}
              <button
                type="button"
                className="signin-eye"
                aria-pressed={showPassword}
                aria-controls="signin-password"
                /*
                   The word is gone from the button and kept for the screen reader.

                   "Show" was a five-letter control sitting where every other product on
                   the machine puts an eye, and it took the width of a word inside a field
                   that has none to spare. `aria-label` says what the glyph means, and it
                   names the ACTION rather than the state - "Show password" when hidden,
                   "Hide password" when shown - because a button labelled with the state it
                   is currently in is the classic way to make a toggle unreadable.
                */
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((was) => !was)}
              >
                {showPassword ? (
                  /* Struck through, which is the convention for "it is showing, hide it".
                     The slash is drawn on the same 24-grid so the two states are the same
                     glyph with one line added rather than two different drawings. */
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                    <path
                      d="M3.3 12S6.9 5.9 12 5.9c1.5 0 2.8.5 4 1.2M20.7 12s-1.2 2-3.2 3.6M9.6 9.7A3.2 3.2 0 0 0 12 15.2c.9 0 1.7-.4 2.3-1"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                    />
                    <path d="m4.5 4.5 15 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                    <path
                      d="M3.3 12S6.9 5.9 12 5.9 20.7 12 20.7 12 17.1 18.1 12 18.1 3.3 12 3.3 12Z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/*
            The refusal, directly under the two fields it is about.

            It used to sit below "Keep me signed in", three rows further down and directly
            above the button you were about to press again - so the thing that had gone
            wrong was as far as it could be from the boxes that caused it.

            A BANNER rather than red text, and that is what separates it from the other red
            on this screen. `--critical-bg` / `--critical-label` are the design system's own
            critical pair rather than a hex chosen here: the kit already decides what "this
            failed" looks like, and it decides it for both themes, which a local colour
            could not.
          */}
          {error !== undefined ? (
            <p role="alert" className="signin-error">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M12 7.4v5.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <circle cx="12" cy="16.4" r="1.05" fill="currentColor" />
              </svg>
              <span>{error}</span>
            </p>
          ) : null}

          {helpOpen ? (
            <p className="signin-help">
              StarLink does not hold your password. Your account comes from the company
              directory, and IT resets it there.
            </p>
          ) : null}

          {/*
            A real setting. Ticked, it asks the server for a fourteen-day session instead of
            twelve hours — see `SL_SESSION_REMEMBER_TTL_SECONDS` for why fourteen and not
            ninety. The server decides both numbers and sets the cookie to match.
          */}
          <label className="signin-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span className="signin-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="11" height="11" focusable="false">
                <path
                  d="m5 12.5 4.5 4.5L19 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            Keep me signed in on this device
          </label>

          <button type="submit" disabled={busy} className="signin-submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        </div>

        {/*
          The footnote is gone, and so is the subtitle above the form.

          Both said true things that nobody signing in needs: that access is limited to
          active employees (which the refusal will say, to the only person it applies to),
          that single sign-on is coming (a roadmap note on a login box), and that this
          screen signs you in to StarLink (which the screen is). Two fields and a button
          need no narration, and the page reads as one object now rather than as a form
          with paragraphs stacked around it.
        */}
        </div>
      </div>

    </main>
  );
}

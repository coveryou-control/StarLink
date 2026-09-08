'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { BrandMark } from '../../components/brand';
import { ConnectionField } from './connection-field';
import { useSession } from '../../components/session-provider';
import { ApiError } from '../../lib/api-client';

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

      {/* The wordmark, top left, as the reference places it. The mark appears again inside
          the card — also as the reference places it, and the two are doing different jobs:
          this one says whose product this is, the one on the card says what you are signing
          in to. */}
      <header className="signin-brandbar">
        <span className="signin-wordmark">
          <BrandMark size={30} />
          StarLink
        </span>
      </header>

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
          <p>Sign in to your CoverYou work account to continue to StarLink.</p>
        </header>

        <form onSubmit={(event) => void submit(event)} className="signin-form">
          {/*
            "Work email", as the directory will label it — and it is already true.

            It said "Username", because that is what `SL_ADAPTER_IAM=local` authenticates
            against and an address would simply not have matched. The adapter takes the
            LOCAL PART of an address now (see `verifyCredential`), so both forms sign the
            same person in: the label matches what HRMS will take when it lands, and
            matches what the box accepts today.
          */}
          <label className="signin-field">
            <span className="signin-label">Work email</span>
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
            <span className="signin-control signin-control-group">
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
                required
                placeholder="name@coveryou.co.in"
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

            <div className="signin-control signin-control-group">
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
                className="signin-quiet"
                aria-pressed={showPassword}
                aria-controls="signin-password"
                onClick={() => setShowPassword((was) => !was)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

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

          {error !== undefined ? (
            <p role="alert" className="signin-error">
              {error}
            </p>
          ) : null}

          <button type="submit" disabled={busy} className="signin-submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        </div>

        {/*
          Outside the panel, deliberately.

          Inside it, this paragraph was a third of the panel's height and turned a compact
          object into a tall one with its weight at the bottom. It is also not part of the
          form: it is a note about who may use the product, which belongs to the page
          rather than to the thing you fill in. Out here it reads as a footnote.
        */}
        <p className="signin-foot">
          Access is limited to active employees. Single sign-on becomes available once
          StarLink is connected to the company directory.
        </p>
        </div>
      </div>

    </main>
  );
}

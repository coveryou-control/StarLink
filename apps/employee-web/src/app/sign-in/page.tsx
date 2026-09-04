'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { BrandLockup } from '../../components/brand';
import { useSession } from '../../components/session-provider';
import { ApiError } from '../../lib/api-client';

export default function SignInPage(): ReactNode {
  const { state, signIn } = useSession();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  /**
   * Defaults to ON, because the design shows it ticked.
   *
   * That is a real decision rather than a copied pixel: this is an internal product on
   * company machines, and the alternative — signing everybody out twice a day — is the
   * behaviour people work around by never closing the tab, which is worse than a longer
   * session they know about. The wording names the DEVICE so somebody at a shared branch
   * terminal has the information they need to untick it.
   */
  const [remember, setRemember] = useState(true);
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
      {/*
        The lockup sits ABOVE the card, not inside it.

        Two things follow from that. The card becomes one thing — a form — instead of a
        form with a masthead glued to the top of it, and the product's name reads as the
        name of the PAGE rather than as the title of the box. It is also what lets the card
        be as short as it is: the heading inside can be "Welcome back" rather than having
        to repeat the product's name to identify the screen.
      */}
      <BrandLockup size={34} />

      <form onSubmit={(event) => void submit(event)} className="signin-card">
        <div className="signin-title">
          <h1>Welcome back</h1>
          <p>Sign in with your CoverYou work account to pick up where you left off.</p>
        </div>

        <div className="signin-fields">
          {/*
            "Work email", as the design labels it — and it is now true.

            It said "Username", because that is what `SL_ADAPTER_IAM=local` authenticates
            against and an address would simply not have matched. The adapter takes the
            LOCAL PART of an address now (see `verifyCredential`), so both forms sign the
            same person in: the label matches the design, matches what HRMS will take when
            it lands, and matches what the box accepts.
          */}
          <label className="signin-field">
            <span className="signin-label">Work email</span>
            <div className="signin-input">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                <rect
                  x="2.75"
                  y="4.75"
                  width="18.5"
                  height="14.5"
                  rx="2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="m3.5 7 8.5 6 8.5-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <input
                type="text"
                inputMode="email"
                autoComplete="username"
                required
                placeholder="name@coveryou.co.in"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
          </label>

          <div className="signin-field">
            {/*
              The label and "Forgot password?" share a row, as the design draws them.

              A `<label>` cannot wrap the link — a click anywhere inside a label focuses its
              control, so the link would both open the help and put the caret in the
              password box. So this is a plain div with an explicit `htmlFor`, which is the
              same association a wrapping label gives and the only one that survives having
              a second interactive thing on the row.
            */}
            <div className="signin-label-row">
              <label className="signin-label" htmlFor="signin-password">
                Password
              </label>
              {/*
                "Forgot password?", and it ANSWERS rather than navigates.

                There is no reset flow in StarLink and there will not be one: the credential
                belongs to the directory, not to this product (rule 11). A link to a page
                that would only say that is one click of nothing — so the answer appears on
                the screen where the question is asked.
              */}
              <button
                type="button"
                className="signin-forgot"
                aria-expanded={helpOpen}
                onClick={() => setHelpOpen((was) => !was)}
              >
                Forgot password?
              </button>
            </div>

            <div className="signin-input">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                <rect
                  x="4.75"
                  y="10.75"
                  width="14.5"
                  height="9.5"
                  rx="2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M8 10.5V8a4 4 0 0 1 8 0v2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <input
                id="signin-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {/*
                Show/hide, which is a security control rather than a convenience.

                A password nobody can read is a password typed wrong twice and then pasted
                from somewhere it should not have been written down. `aria-pressed` rather
                than changing the label alone, so a screen reader hears the state instead of
                inferring it from a word that means the opposite of what it does.
              */}
              <button
                type="button"
                className="signin-reveal"
                aria-pressed={showPassword}
                aria-controls="signin-password"
                onClick={() => setShowPassword((was) => !was)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
        </div>

        {helpOpen ? (
          <p className="signin-help">
            StarLink does not hold your password. Your account comes from the company
            directory, and IT resets it there.
          </p>
        ) : null}

        {/*
          A real setting, not decoration.

          Ticked, this asks the server for a fourteen-day session instead of twelve hours —
          see `SL_SESSION_REMEMBER_TTL_SECONDS`, which explains why fourteen and not ninety.
          The server decides both numbers and sets the cookie to match; the box asks a
          question, it does not set a duration.
        */}
        <label className="signin-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span className="signin-check" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12" focusable="false">
              <path
                d="m5 12.5 4.5 4.5L19 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
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
          {busy ? null : (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path
                d="m9.5 5.5 6.5 6.5-6.5 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </form>
    </main>
  );
}

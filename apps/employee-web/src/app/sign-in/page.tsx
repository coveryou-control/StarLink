'use client';

import { BrandLockup } from '../../components/brand';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { useSession } from '../../components/session-provider';
import { ApiError } from '../../lib/api-client';

export default function SignInPage(): ReactNode {
  const { state, signIn } = useSession();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
      await signIn(username, password);
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
      <form onSubmit={(event) => void submit(event)} className="signin-card">
        <div className="signin-head">
          <BrandLockup size={40} />
          <div className="signin-title">
            <h1>Sign in to Starlink</h1>
            <p>Use your CoverYou work account. Conversations stay inside the company.</p>
          </div>
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
            <span>Work email</span>
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

          <label className="signin-field">
            <span>Password</span>
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
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </label>

          {/*
            "Forgot password?", and it ANSWERS rather than navigates.

            There is no reset flow in StarLink and there will not be one: the credential
            belongs to the directory, not to this product (rule 11). A link to a page that
            would only say that is one click of nothing — so the answer is on the screen
            where the question is asked.
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

        {helpOpen ? (
          <p className="signin-help">
            StarLink does not hold your password. Your account comes from the company
            directory, and IT resets it there.
          </p>
        ) : null}

        {error !== undefined ? (
          <p role="alert" className="signin-error">
            {error}
          </p>
        ) : null}

        <div className="signin-actions">
          <button type="submit" disabled={busy} className="signin-submit">
            {busy ? 'Signing in\u2026' : 'Sign in'}
          </button>

          <div className="signin-or">
            <span aria-hidden="true" />
            or
            <span aria-hidden="true" />
          </div>

          {/*
            The design's second route in, DISABLED rather than absent or pretend.

            SSO is what `SL_ADAPTER_IAM` will do once HRMS is connected; today it is `local`
            and there is nothing behind this button. A working-looking button that did
            nothing would be worse than either choice — so it is on screen, in the design's
            own treatment, visibly unavailable, and the note below says when it will not be.
            Somebody arriving expecting SSO is told why rather than left wondering whether
            they mis-clicked.
          */}
          <button type="button" className="signin-sso" disabled>
            Continue with company SSO
          </button>
        </div>

        <p className="signin-note">
          Access is limited to active employees. Single sign-on becomes available once
          StarLink is connected to the company directory.
        </p>
      </form>

      <p className="signin-footer">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
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
        Work conversations, kept at work.
      </p>
    </main>
  );
}

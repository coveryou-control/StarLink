'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { BrandMark } from '../../components/brand';
import { useSession } from '../../components/session-provider';
import { ApiError } from '../../lib/api-client';

/**
 * Sign in.
 *
 * ## The reference's own palette, applied directly
 *
 * Lavender panel, yellow disc, white fields, indigo pill, and a 2px ink outline on every
 * one of them. Asked for on 2026-09-04 — "use the exact same colours and design pattern" —
 * which supersedes the earlier instruction not to take a reference's colours.
 *
 * ## This screen does not use the product palette
 *
 * Worth knowing rather than discovering: everywhere else in StarLink, CY Orange is the one
 * signal colour and rule 1 bounds where it may appear. Here it appears nowhere. Somebody
 * signing in meets one colour world and lands in another, which is a deliberate, isolated
 * departure and not a drift.
 *
 * ## What the reference does that this does not
 *
 * It has no labels — two bare boxes under two placeholder lines. Placeholders are not
 * labels: they vanish the moment somebody types, they are announced inconsistently, and a
 * form relying on them fails NFR-ACC-1. The labels stay, set small and in the ink so they
 * sit inside the pattern rather than fighting it.
 *
 * It also has no "Forgot password?", no show/hide and no remember box, because it is a
 * thumbnail rather than a product. All three are real controls here and all three stay.
 *
 * ## The mark
 *
 * The reference's yellow disc, carrying StarLink's own letter. `.brand-mark` is overridden
 * for this page only — the rail and every other surface keep the product's near-black
 * squircle, so the override cannot leak into them.
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
      <div className="signin-panel">
        <header className="signin-masthead">
          <BrandMark size={64} round />
          <h1>Sign in to StarLink</h1>
          <p>CoverYou&rsquo;s internal workspace. Conversations stay inside the company.</p>
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
            <input
              className="signin-control"
              type="text"
              inputMode="email"
              autoComplete="username"
              required
              placeholder="name@coveryou.co.in"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
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
        form: it is a note about who may use the product, which belongs to the page rather
        than to the thing you fill in. Out here it reads as a footnote, which is what it is.
      */}
      <p className="signin-foot">
        Access is limited to active employees. Single sign-on becomes available once
        StarLink is connected to the company directory.
      </p>
    </main>
  );
}

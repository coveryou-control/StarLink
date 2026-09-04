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
 * ## The composition
 *
 * One column, centred, no card. The card was the thing making this read as a template: a
 * bordered box floating on a patterned ground is the shape of every SaaS sign-in, and it
 * puts a frame around a form that is already the only thing on the page. Without it the
 * form IS the page — which is what "integrated" means here, and what Linear, Vercel and
 * Stripe all do on this screen.
 *
 * What replaces the card's job of grouping is spacing. The mark, the heading, the fields
 * and the action sit at deliberately different distances from each other, so the eye reads
 * four groups without a border telling it to.
 *
 * ## The mark alone
 *
 * No wordmark. The heading says "Sign in to StarLink" one line below it, so a lockup would
 * print the product's name twice in forty pixels. A mark on its own also behaves like a
 * mark rather than a masthead — it identifies without announcing, which is the register an
 * internal tool wants.
 *
 * ## Restraint over decoration
 *
 * No icons in the fields: a mail glyph beside a box labelled "Work email" is a second
 * statement of the same fact, and two of them make the form look busier than it is. No
 * gradient, no glass. The one saturated thing on the screen is the button, which is the
 * one thing to press.
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
      <div className="signin-column">
        <header className="signin-masthead">
          <BrandMark size={36} />
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

        {/*
          One quiet line, separated by a rule.

          It is the only place the page says anything about access, and it belongs at the
          foot rather than under the button — a sentence between the CTA and the edge of the
          form would compete with the thing somebody came here to press.
        */}
        <p className="signin-foot">
          Access is limited to active employees. Single sign-on becomes available once
          StarLink is connected to the company directory.
        </p>
      </div>
    </main>
  );
}

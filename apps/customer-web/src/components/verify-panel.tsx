'use client';

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, api } from '../lib/api-client';

type Step = 'CONTACT' | 'CODE';

interface VerifyPanelProps {
  /** Called once assurance has actually been raised. */
  readonly onVerified: () => void;
}

/**
 * "To continue, please add your details."
 *
 * The gate between choosing a topic and typing, approved 2026-08-26. The customer
 * browses topics with no session at all, then proves a contact detail, and only then
 * does the composer appear — so no conversation can exist that we have no way to reply
 * to, and §21.5's ordering (identity before routing) holds.
 *
 * Two things this panel is careful about:
 *
 *   * **It never says whether the number is known to us.** The API behaves identically
 *     for a recognised and an unrecognised contact, and this UI must not undo that by
 *     saying "welcome back" — that would turn the form into a way to ask "is this person
 *     your customer?".
 *   * **It reports attempts remaining rather than inventing a reason.** Every failure
 *     comes back as one refusal; guessing at "wrong code" versus "expired" would be a
 *     guess presented as fact.
 */
export function VerifyPanel({ onVerified }: VerifyPanelProps): ReactNode {
  const [step, setStep] = useState<Step>('CONTACT');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const sendCode = useCallback(async () => {
    const trimmed = mobile.trim();
    if (trimmed === '') return;
    setBusy(true);
    setError(undefined);
    try {
      // The session is created HERE, with the contact detail as a hint — not when the
      // widget opened. Someone who reads the topics and leaves creates nothing.
      await api.startSession({ mobile: trimmed });
      const challenge = await api.beginVerification('OTP_MOBILE');
      setChallengeId(challenge.challengeId);
      setStep('CODE');
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.isUnreachable
          ? 'We could not reach us just now. Please try again.'
          : 'We could not send a code to that number. Please check it and try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [mobile]);

  const submitCode = useCallback(async () => {
    if (challengeId === undefined || code.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      await api.completeVerification(challengeId, code.trim());
      // Deliberately NOT branching on `recognised`. Whether we know this person is not
      // something the panel should announce.
      onVerified();
    } catch {
      setError('That code did not work. Please check it and try again.');
    } finally {
      setBusy(false);
    }
  }, [challengeId, code, onVerified]);

  return (
    <div style={{ padding: 16 }}>
      <p style={{ marginTop: 0, fontWeight: 600 }}>To continue, please add your details</p>
      <p style={{ marginTop: 0, color: 'var(--text-muted)', fontSize: 14 }}>
        We&apos;ll send you a one-time code so we can reply to you.
      </p>

      {step === 'CONTACT' ? (
        <>
          <label htmlFor="verify-mobile" style={labelStyle}>
            Mobile number
          </label>
          <input
            id="verify-mobile"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={mobile}
            onChange={(event) => setMobile(event.target.value)}
            placeholder="+91…"
            style={fieldStyle}
          />
          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={busy || mobile.trim() === ''}
            style={buttonStyle(busy || mobile.trim() === '')}
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </>
      ) : (
        <>
          <label htmlFor="verify-code" style={labelStyle}>
            Enter the code
          </label>
          <input
            id="verify-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="6-digit code"
            style={fieldStyle}
          />
          <button
            type="button"
            onClick={() => void submitCode()}
            disabled={busy || code.trim() === ''}
            style={buttonStyle(busy || code.trim() === '')}
          >
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('CONTACT');
              setCode('');
              setError(undefined);
            }}
            style={{ ...buttonStyle(false), background: 'transparent', color: 'var(--accent)' }}
          >
            Use a different number
          </button>
        </>
      )}

      {error !== undefined ? (
        <p role="alert" style={{ color: 'var(--danger)', fontSize: 14 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', marginBottom: 4, fontSize: 14 };

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: 12,
  marginBottom: 12,
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  background: 'var(--bg)',
};

const buttonStyle = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  padding: 12,
  marginBottom: 8,
  borderRadius: 'var(--radius)',
  border: 'none',
  fontWeight: 600,
  background: disabled ? 'var(--surface-2)' : 'var(--accent)',
  color: disabled ? 'var(--text-muted)' : 'var(--accent-contrast)',
});

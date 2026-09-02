'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, api, type MeResponse } from '../lib/api-client';
import { DraftStore } from '../lib/drafts';

type SessionState =
  | { readonly status: 'LOADING' }
  | { readonly status: 'SIGNED_OUT' }
  | { readonly status: 'SIGNED_IN'; readonly me: MeResponse };

interface SessionContextValue {
  readonly state: SessionState;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Called when any request comes back 401 — the session was revoked server-side
   * (FR-AUTH-2). The shell drops to signed-out immediately rather than leaving stale
   * data on screen for someone whose access was just withdrawn.
   */
  onUnauthenticated: () => void;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<SessionState>({ status: 'LOADING' });

  // Drafts are per-principal and client-only; wiping them on the way out is what stops
  // one person's unsent words appearing to the next user of a shared machine.
  const wipeDraftsFor = useCallback(async (principalId: string | undefined) => {
    if (principalId === undefined) return;
    try {
      await DraftStore.clearAllFor(principalId);
    } catch {
      // A failure to clear local drafts must not block sign-out.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api
      .me()
      .then((me) => {
        if (!cancelled) setState({ status: 'SIGNED_IN', me });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'SIGNED_OUT' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      async signIn(username, password) {
        // Sign-in returns only the id. The profile comes from `me()`, so there is
        // exactly one shape for "who am I" rather than two that could drift.
        await api.signIn(username, password);
        setState({ status: 'SIGNED_IN', me: await api.me() });
      },
      async signOut() {
        const principalId = state.status === 'SIGNED_IN' ? state.me.principalId : undefined;
        try {
          await api.signOut();
        } catch (error) {
          // Already-invalid sessions still end locally.
          if (!(error instanceof ApiError)) throw error;
        }
        await wipeDraftsFor(principalId);
        setState({ status: 'SIGNED_OUT' });
      },
      onUnauthenticated() {
        setState((current) => {
          if (current.status === 'SIGNED_IN') void wipeDraftsFor(current.me.principalId);
          return { status: 'SIGNED_OUT' };
        });
      },
    }),
    [state, wipeDraftsFor],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (context === undefined) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}

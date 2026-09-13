'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import { declaredStatusLabel } from '@starlink/shared-contracts';
import type { DeclaredStatusView } from '../lib/api-client';

/**
 * The set of colleagues currently holding a realtime lease, shared down the tree.
 *
 * The shell asks once for everybody on screen; the list rows, the chat header, the
 * directory and the member list all read from here. Four components each opening their own
 * socket would be four connections and four timers giving four answers.
 */
const PresenceContext = createContext<ReadonlySet<string>>(new Set());

/**
 * What people SAY they are doing, alongside whether they are connected.
 *
 * A second context rather than a merged one, because they answer different questions and
 * §21.9 turns on keeping them apart: presence is inferred from a socket and may say only
 * "connected", while a declared status is a sentence the person typed. Somebody can be
 * offline with "in a meeting" set, and online with it too. Merging them into one value
 * would force a precedence rule between two facts that are both true.
 */
const DeclaredStatusContext = createContext<ReadonlyMap<string, DeclaredStatusView>>(new Map());

export function PresenceProvider({
  online,
  statuses,
  children,
}: {
  readonly online: ReadonlySet<string>;
  /** Absent for anybody available — see `useDeclaredStatuses`. */
  readonly statuses?: ReadonlyMap<string, DeclaredStatusView>;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <PresenceContext.Provider value={online}>
      <DeclaredStatusContext.Provider value={statuses ?? EMPTY_STATUSES}>
        {children}
      </DeclaredStatusContext.Provider>
    </PresenceContext.Provider>
  );
}

/* Module scope, so the default is one object rather than a new Map per render — a fresh
   value would re-render every consumer of the context on every render of the shell. */
const EMPTY_STATUSES: ReadonlyMap<string, DeclaredStatusView> = new Map();

export function useDeclaredStatus(principalId: string | undefined): DeclaredStatusView | undefined {
  const statuses = useContext(DeclaredStatusContext);
  return principalId === undefined ? undefined : statuses.get(principalId);
}

export function useIsOnline(principalId: string | undefined): boolean {
  const online = useContext(PresenceContext);
  return principalId !== undefined && online.has(principalId);
}

export function useOnlineSet(): ReadonlySet<string> {
  return useContext(PresenceContext);
}

/**
 * A dot on the corner of an avatar.
 *
 * ## Two states, not four
 *
 * `PresenceState` admits ONLINE, AWAY, BUSY and OFFLINE; the gateway writes exactly one of
 * them. So this shows a dot or it shows nothing — an "away" amber would be a state the
 * system cannot produce, and §21.9 forbids reading availability out of a socket at all.
 *
 * ## Absence is not a claim
 *
 * Offline renders NOTHING rather than a grey dot. A grey dot asserts "this person is not
 * at their desk"; an absent dot says only that StarLink has no signal, which is the honest
 * reading — they may be connected on a phone that has not polled, or the query may have
 * failed. The difference matters because people act on presence.
 *
 * The name is on the dot for a screen reader, which has neither the position nor the
 * colour. Nothing is announced when there is no dot, for the same reason.
 */
export function PresenceDot({ principalId }: { readonly principalId: string | undefined }): ReactNode {
  const online = useIsOnline(principalId);
  if (!online) return null;
  return (
    <span className="presence-dot" title="Online">
      <span className="sr-only">Online</span>
    </span>
  );
}

/**
 * The words beside a name: "Busy", "In a meeting", "Away".
 *
 * Rendered only when there is something to say. AVAILABLE never reaches here — the server
 * omits it and omits anything lapsed — so an absent badge means the honest thing: nothing
 * has been claimed.
 *
 * Text, not a coloured dot. The dot is already taken by presence, a second one beside it
 * would be two dots meaning two different things, and the words survive greyscale
 * (NFR-ACC-3) where a hue does not. The colour is a tint behind the words, so somebody who
 * has learned it reads it faster and somebody who has not still reads it.
 */
export function DeclaredStatusBadge({
  principalId,
}: {
  readonly principalId: string | undefined;
}): ReactNode {
  const status = useDeclaredStatus(principalId);
  if (status === undefined) return null;
  return (
    <span className={`status-badge status-${status.status.toLowerCase()}`}>
      {declaredStatusLabel(status.status)}
    </span>
  );
}

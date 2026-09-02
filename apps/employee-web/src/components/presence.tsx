'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * The set of colleagues currently holding a realtime lease, shared down the tree.
 *
 * The shell asks once for everybody on screen; the list rows, the chat header, the
 * directory and the member list all read from here. Four components each opening their own
 * socket would be four connections and four timers giving four answers.
 */
const PresenceContext = createContext<ReadonlySet<string>>(new Set());

export function PresenceProvider({
  online,
  children,
}: {
  readonly online: ReadonlySet<string>;
  readonly children: ReactNode;
}): ReactNode {
  return <PresenceContext.Provider value={online}>{children}</PresenceContext.Provider>;
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

/**
 * The thread reconnects when the device does, not when the backoff elapses.
 *
 * ## The defect
 *
 * `use-realtime` configures Socket.IO with `reconnectionDelayMax: 30_000` and full jitter,
 * which is correct for a server outage — five hundred employees returning in lockstep will
 * kill the instance that replaced the one that just died.
 *
 * It is wrong for the ordinary case. One person walks out of a lift and their own
 * connectivity is back; nothing is protected by making them wait, and the thread sits
 * showing RECONNECTING for up to half a minute while messages sent to them do not arrive.
 * The conversation page has no polling fallback — the queue, the bell and the load panel
 * all poll, this does not — so the socket is the only thing that recovers it.
 *
 * ## Why a source guard rather than only the browser test
 *
 * `drafts-and-offline.spec.ts` covers this behaviourally and is the stronger proof, but it
 * covered it *intermittently*: with the listeners absent the outcome depended on where in
 * a jittered 30-second backoff the network happened to return, so the suite failed in four
 * runs out of five and passed the file in isolation every time. A test that fails only
 * sometimes does not protect a line of code — it teaches people to re-run.
 *
 * These assertions are deterministic. They cannot prove the reconnect works; the browser
 * test does that. They prove the two listeners that make it prompt are still there.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'use-realtime.ts'), 'utf8');

describe('prompt reconnection', () => {
  it('reconnects on the browser online event', () => {
    expect(
      /addEventListener\('online',/.test(source),
      'nothing listens for connectivity returning — the thread waits out the backoff',
    ).toBe(true);
  });

  it('reconnects when a backgrounded tab becomes visible again', () => {
    /**
     * The other half, and the one a phone actually hits: the OS closes the socket while
     * the app is backgrounded, and no `online` event fires because connectivity never
     * went away. The person is looking at the thread now.
     */
    expect(
      /addEventListener\('visibilitychange',/.test(source),
      'a backgrounded tab does not reconnect when it comes back',
    ).toBe(true);
    expect(source).toContain("document.visibilityState === 'visible'");
  });

  it('only nudges a socket that is actually disconnected', () => {
    /**
     * `connect()` on a live socket is a no-op, but calling it unconditionally on every
     * visibility change is the kind of thing that later grows into a reconnect loop. The
     * guard states the intent.
     */
    expect(source).toContain('if (!socket.connected) socket.connect();');
  });

  it('removes both listeners when the hook unmounts', () => {
    /**
     * These are on `window` and `document`, which outlive the component. Without the
     * removals, every thread ever opened keeps a listener holding a closure over a dead
     * socket, and one `online` event wakes all of them.
     */
    expect(source).toContain("removeEventListener('online',");
    expect(source).toContain("removeEventListener('visibilitychange',");
  });

  it('keeps the jittered backoff for a genuine server outage', () => {
    /**
     * The positive control for the whole file. Every assertion above is satisfied by
     * deleting the backoff and reconnecting in a tight loop, which is the failure mode the
     * backoff exists to prevent — and it would look fine on one developer's machine.
     */
    expect(source).toContain('reconnectionDelayMax: 30_000');
    expect(source).toContain('randomizationFactor: 1.0');
  });
});

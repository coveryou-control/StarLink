/**
 * Quiet hours decide whether a phone buzzes at 3am, so the cases that matter are the
 * awkward ones: the window that crosses midnight, the zone that is not the server's, and
 * every way the input can be wrong.
 */
import { describe, expect, it } from 'vitest';

import { inQuietWindow } from './quiet-hours.js';

/* 18:30 UTC. In Asia/Kolkata (+05:30) that is midnight; in Europe/London in September
   (BST, +01:00) it is 19:30. One instant, three local answers — which is the entire
   reason the zone is stored rather than an offset. */
const AT = new Date('2026-09-11T18:30:00.000Z');

describe('a window that crosses midnight', () => {
  const evening = { from: '20:00', to: '09:00', timeZone: 'Asia/Kolkata' };

  it('is quiet at local midnight', () => {
    // 18:30Z is 00:00 in Kolkata. A naive `from <= now && now < to` says false here, and
    // 20:00-09:00 is what almost everybody means by "evening".
    expect(inQuietWindow(evening, AT)).toBe(true);
  });

  it('is quiet just after it starts and just before it ends', () => {
    expect(inQuietWindow(evening, new Date('2026-09-11T14:31:00.000Z'))).toBe(true); // 20:01
    expect(inQuietWindow(evening, new Date('2026-09-11T03:29:00.000Z'))).toBe(true); // 08:59
  });

  it('is not quiet in the working day', () => {
    expect(inQuietWindow(evening, new Date('2026-09-11T06:30:00.000Z'))).toBe(false); // 12:00
  });

  it('is inclusive of its start and exclusive of its end', () => {
    // One rule, stated: a window is [from, to). Without it, either 20:00 or 09:00 is
    // ambiguous and somebody argues about the minute for ever.
    expect(inQuietWindow(evening, new Date('2026-09-11T14:30:00.000Z'))).toBe(true); // 20:00
    expect(inQuietWindow(evening, new Date('2026-09-11T03:30:00.000Z'))).toBe(false); // 09:00
  });
});

describe('a window inside one day', () => {
  const siesta = { from: '13:00', to: '15:00', timeZone: 'Asia/Kolkata' };

  it('is quiet inside and noisy outside', () => {
    expect(inQuietWindow(siesta, new Date('2026-09-11T08:00:00.000Z'))).toBe(true); // 13:30
    expect(inQuietWindow(siesta, new Date('2026-09-11T11:00:00.000Z'))).toBe(false); // 16:30
  });
});

describe('the zone is the point', () => {
  it('answers differently for two devices at the same instant', () => {
    /* The reason this is per device rather than per person, and per zone rather than
       per offset: one notification, two phones, two correct answers. */
    const window = { from: '20:00', to: '09:00' };
    expect(inQuietWindow({ ...window, timeZone: 'Asia/Kolkata' }, AT)).toBe(true); // 00:00
    expect(inQuietWindow({ ...window, timeZone: 'Europe/London' }, AT)).toBe(false); // 19:30
  });

  it('follows daylight saving rather than a fixed offset', () => {
    /**
     * London is +01:00 in September and +00:00 in January. An offset captured at
     * registration would be an hour wrong for half the year, silently, and in the
     * direction that wakes somebody at 06:00.
     */
    const window = { from: '20:00', to: '09:00', timeZone: 'Europe/London' };
    // 19:30Z: 20:30 local in summer (quiet), 19:30 local in winter (not).
    expect(inQuietWindow(window, new Date('2026-09-11T19:30:00.000Z'))).toBe(true);
    expect(inQuietWindow(window, new Date('2026-01-11T19:30:00.000Z'))).toBe(false);
  });
});

describe('everything that cannot be evaluated DELIVERS', () => {
  /**
   * The direction matters more than the cases.
   *
   * Treating "I cannot tell" as quiet mutes a device for ever with nothing to show for
   * it, and the person has no way to discover why — indistinguishable from the feature
   * being broken. A notification held that should not have been is an annoyance; one
   * dropped for ever is a missed escalation.
   */
  it('no window at all', () => {
    expect(inQuietWindow(undefined, AT)).toBe(false);
  });

  it('a time that is not a time', () => {
    for (const bad of ['25:00', '7:00', '20:60', '', 'evening', '20:00:00']) {
      expect(inQuietWindow({ from: bad, to: '09:00', timeZone: 'Asia/Kolkata' }, AT), bad).toBe(
        false,
      );
    }
  });

  it('a zone the runtime does not know', () => {
    expect(inQuietWindow({ from: '20:00', to: '09:00', timeZone: 'Mars/Olympus' }, AT)).toBe(false);
  });

  it('a window of zero length, which is a half-filled form and not a whole day', () => {
    // Reading `20:00-20:00` as "always quiet" would silence a device permanently on what
    // is almost certainly an input nobody finished.
    expect(inQuietWindow({ from: '20:00', to: '20:00', timeZone: 'Asia/Kolkata' }, AT)).toBe(false);
  });
});

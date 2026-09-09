import { describe, expect, it } from 'vitest';

import { LocalObjectStorage } from './local/local-object-storage.js';
import { MockObjectStorage } from './mock/mock-object-storage.js';
import { S3ObjectStorage } from './s3/s3-object-storage.js';

/**
 * Every driver must be able to hand the scanner its bytes.
 *
 * ## The defect this exists to prevent recurring
 *
 * The scanner's byte reader was wired as
 * `storage instanceof MockObjectStorage ? storage.readQuarantine(key) : undefined`, and the
 * comment beside it claimed the narrowing would make a driver without the method fail to
 * compile. It did not — it made one return `undefined` at runtime.
 *
 * `LocalObjectStorage` extends the mock, so development worked and the gap was invisible.
 * `S3ObjectStorage` does not, and it is the only driver a deployed environment may use
 * (`config.ts` refuses the others on staging and production). So under the one
 * configuration that could ship: every read returned `undefined`, every scan reported
 * QUARANTINE_OBJECT_MISSING, the row went back to QUARANTINED, and no attachment was ever
 * promoted to BOUND. Nothing unscanned became reachable — it fails closed — but no
 * attachment would ever have been downloadable, and nothing anywhere said so.
 *
 * `ObjectStorageProvider` deliberately has no read method: the application never streams
 * file contents (ADR-012). So the capability cannot be enforced by the port's type, and
 * this is where it is enforced instead — over the drivers as a SET, so a new one that
 * forgets is a failing test rather than a silent production outage.
 */
describe('every object-storage driver can be scanned against', () => {
  const drivers = [
    ['MockObjectStorage', () => new MockObjectStorage()],
    ['LocalObjectStorage', () => new LocalObjectStorage()],
    [
      'S3ObjectStorage',
      () => new S3ObjectStorage({ bucket: 'starlink-attachments', region: 'ap-south-1' }),
    ],
  ] as const;

  it.each(drivers)('%s exposes readQuarantine', (_name, build) => {
    const driver = build() as unknown as { readQuarantine?: unknown };
    expect(typeof driver.readQuarantine).toBe('function');
  });

  it('refuses a key that is not in quarantine', async () => {
    /* The scanner only ever reads quarantined objects. A driver that would fetch a CLEAN
       key on request is one step from being a general file reader, which is the affordance
       ADR-012 keeps off the port in the first place. */
    const s3 = new S3ObjectStorage({ bucket: 'starlink-attachments', region: 'ap-south-1' });
    await expect(s3.readQuarantine('clean/0f9b1f34-2f3e-4c19-9a1a-9d9a2b7c1e55')).resolves.toBe(
      undefined,
    );
  });
});

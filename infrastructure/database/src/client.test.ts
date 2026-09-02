/**
 * TLS inference.
 *
 * Inferred rather than configured, because the failure mode of a forgotten flag is
 * silent: the application works, and message content crosses the public internet in
 * clear (NFR-SEC-4). The only way to get plaintext to a remote host is to ask for it
 * explicitly.
 */
import { describe, expect, it } from 'vitest';
import { requiresTls } from './client.js';

describe('requiresTls', () => {
  it('does not require TLS for a loopback database', () => {
    for (const host of ['localhost', '127.0.0.1']) {
      expect(requiresTls(`postgres://u:p@${host}:5432/starlink`), host).toBe(false);
    }
  });

  it('REQUIRES TLS for any remote host, with no flag needed', () => {
    for (const url of [
      'postgres://u:p@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/starlink',
      'postgres://u:p@starlink.abcdef.ap-south-1.rds.amazonaws.com:5432/starlink',
      'postgres://u:p@10.0.1.20:5432/starlink',
    ]) {
      expect(requiresTls(url), url).toBe(true);
    }
  });

  it('honours an explicit sslmode=disable, since that is a deliberate choice', () => {
    expect(requiresTls('postgres://u:p@db.internal:5432/starlink?sslmode=disable')).toBe(false);
  });

  it('fails SAFE on an unparseable connection string', () => {
    // If we cannot tell where we are connecting, assume the internet.
    expect(requiresTls('not-a-url')).toBe(true);
  });

  it('still requires TLS when the URL carries Neon-style parameters', () => {
    expect(
      requiresTls('postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/starlink?sslmode=require&channel_binding=require'),
    ).toBe(true);
  });
});

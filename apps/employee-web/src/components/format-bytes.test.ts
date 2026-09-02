/**
 * File sizes on an attachment chip.
 *
 * Small, and each case is a specific way of being wrong in front of somebody who has just
 * seen the same number in their operating system's file dialog.
 */
import { describe, expect, it } from 'vitest';

import { formatBytes } from './attachment-picker';

describe('formatBytes', () => {
  it('uses binary units, matching the file dialog the person just used', () => {
    // 1500 bytes is 1.5 kB decimal and 1 KB binary. Windows and macOS both say the latter
    // here, and a chip disagreeing with the dialog is a wrongness nobody can explain.
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1500)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });

  it('shows bytes below a kilobyte rather than "0.0 KB"', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(940)).toBe('940 B');
  });

  it('drops the decimal once the number is large enough not to need it', () => {
    // "12.4 MB" and "12 MB" are the same information; the second is narrower on a chip
    // that has to share a row with a filename.
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('stops at gigabytes rather than running off the unit list', () => {
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(4096 * 1024 ** 3)).toContain('GB');
  });

  it('returns empty for a value that is not a size', () => {
    // A chip is allowed to lose its size; it is not allowed to print NaN next to a
    // filename.
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});

import { describe, expect, it } from 'vitest';

import { DevAttachmentScanner } from './dev-scanner';

/**
 * Video containers, and the two ways a sniffer gets ISO base media wrong.
 *
 * ## The bug this pins
 *
 * `ftyp` at offset 4 was mapped to `audio/mp4` and nothing else, and the policy requires
 * the sniffed type to EQUAL the declared one. So every video the composer offered to
 * attach was refused twice over — once by an allow-list with no video type on it, and
 * once by a sniffer that called an .mp4 an .m4a. What a person saw was "That file cannot
 * be attached here", over a menu item reading "Photos & videos".
 *
 * ## The two failure modes, and why both need a test
 *
 * Too NARROW: pinning `isom` to one of audio or video refuses the other, and both are
 * written with that brand — Safari's voice recorder among them. A fix that made videos
 * work by breaking voice notes would pass a test that only checked videos.
 *
 * Too WIDE: accepting any declared type over any bytes would also make videos work, and
 * would be the sniffer not sniffing. The refusals below are the half that matters.
 */
describe('video containers are recognised without widening the sniffer', () => {
  const scannerFor = (bytes: Uint8Array): DevAttachmentScanner =>
    new DevAttachmentScanner({ storage: { read: async () => bytes } });

  /** An ISO base-media header: a length field, `ftyp`, then the major brand. */
  const iso = (brand: string): Uint8Array => {
    const bytes = new Uint8Array(64);
    bytes.set([0x00, 0x00, 0x00, 0x20], 0);
    bytes.set([0x66, 0x74, 0x79, 0x70], 4);
    bytes.set([...brand].map((c) => c.charCodeAt(0)), 8);
    return bytes;
  };

  const scan = async (bytes: Uint8Array, declaredMime: string) => {
    const result = await scannerFor(bytes).scan({
      quarantineKey: 'quarantine/8a7d2e64-6c1e-4a55-9f0e-1f2f3a4b5c6d',
      declaredMime,
      declaredBytes: bytes.byteLength,
    });
    if (!result.ok) throw new Error('the scanner failed rather than reaching a verdict');
    return result.value;
  };

  it('accepts an MP4 video declared as one', async () => {
    const verdict = await scan(iso('isom'), 'video/mp4');
    expect(verdict.verdict).toBe('CLEAN');
    expect(verdict.verdict === 'CLEAN' && verdict.sniffedMime).toBe('video/mp4');
  });

  it('still accepts an audio-only MP4 on the SAME brand', async () => {
    /*
       The regression this exists to catch. `isom` is written for both, so the brand
       cannot decide — and a voice note that stopped uploading because videos started
       would be a worse bug than the one being fixed.
    */
    const verdict = await scan(iso('isom'), 'audio/mp4');
    expect(verdict.verdict).toBe('CLEAN');
    expect(verdict.verdict === 'CLEAN' && verdict.sniffedMime).toBe('audio/mp4');
  });

  it('pins M4A to audio, so a video declared over one is refused', async () => {
    /* Where the brand IS decisive it decides, and the set does not apply. */
    expect((await scan(iso('M4A '), 'audio/mp4')).verdict).toBe('CLEAN');
    expect((await scan(iso('M4A '), 'video/mp4')).verdict).toBe('REJECTED');
  });

  it('reads QuickTime and AVIF from their brands', async () => {
    expect((await scan(iso('qt  '), 'video/quicktime')).verdict).toBe('CLEAN');
    expect((await scan(iso('avif'), 'image/avif')).verdict).toBe('CLEAN');
    /* And a QuickTime file declared as an MP4 is still a disagreement. */
    expect((await scan(iso('qt  '), 'video/mp4')).verdict).toBe('REJECTED');
  });

  it('accepts WebM declared as video as well as audio', async () => {
    /* EBML is one header for both, which the sheet has said in a comment since voice
       notes shipped and did not enforce: `video/webm` was refused. */
    const ebml = new Uint8Array(64);
    ebml.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    expect((await scan(ebml, 'video/webm')).verdict).toBe('CLEAN');
    expect((await scan(ebml, 'audio/webm')).verdict).toBe('CLEAN');
  });

  it('recognises GIF and WEBP, and does not mistake other RIFF forms for WEBP', async () => {
    const gif = new Uint8Array(64);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
    expect((await scan(gif, 'image/gif')).verdict).toBe('CLEAN');

    const webp = new Uint8Array(64);
    webp.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    webp.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    expect((await scan(webp, 'image/webp')).verdict).toBe('CLEAN');

    /* A WAV is RIFF too. Matching `RIFF` alone would have claimed it as a picture. */
    const wav = new Uint8Array(64);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    expect((await scan(wav, 'image/webp')).verdict).toBe('REJECTED');
  });

  it('refuses an executable however it is declared', async () => {
    /* The sniffer is still a sniffer. Nothing above may be read as "the declaration is
       trusted": the sets never cross a container boundary. */
    const exe = new Uint8Array(64);
    exe.set([0x4d, 0x5a], 0); // MZ
    for (const declared of ['video/mp4', 'video/webm', 'image/webp', 'audio/mp4']) {
      expect((await scan(exe, declared)).verdict).toBe('REJECTED');
    }
  });
});

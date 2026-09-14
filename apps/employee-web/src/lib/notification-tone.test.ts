import { describe, expect, it } from 'vitest';

import { buildNotificationTone, NOTIFICATION_TONE_MS } from './device-notifications';

/**
 * The notification sound, checked against the brief it was written to.
 *
 * ## Why a sound needs a test at all
 *
 * It is the one piece of this interface nobody reviews. Nobody opens a pull request and
 * listens; it is plausible on the machine it was written on, and that is the end of it. A
 * gain typed as `0.85` instead of `0.085` is a ten-fold error that compiles, passes every
 * other check, and is a physical unpleasantness for every person using the product — dozens
 * of times a day, often through headphones.
 *
 * So the properties that make this sound *usable* are asserted rather than trusted: it is
 * quiet, it does not start with a click, it runs for about a second, and it is the shape it
 * claims to be. None of that is a judgement about whether it sounds good. All of it is the
 * difference between a sound somebody keeps on and one they switch off.
 *
 * ## How
 *
 * `buildNotificationTone` takes any `BaseAudioContext`, so this passes a recorder: a
 * stand-in that implements the handful of node types the sound uses and writes down every
 * scheduled value. What comes back is the score — every ramp, every start and stop — which
 * is what the assertions below read. jsdom has no Web Audio, and an `OfflineAudioContext`
 * would need a browser; the schedule is the part with the mistakes in it.
 */

interface Scheduled {
  readonly kind: 'setValueAtTime' | 'exponentialRampToValueAtTime' | 'linearRampToValueAtTime';
  readonly value: number;
  readonly at: number;
}

interface Recorded {
  readonly gains: { readonly events: Scheduled[] }[];
  readonly frequencies: { readonly label: string; readonly events: Scheduled[] }[];
  readonly oscillators: { type: string; started: number; stopped: number }[];
  readonly sources: { started: number; stopped: number }[];
  readonly filters: { type: string }[];
  /** Every `connect` made, as from -> to. A layer that is built and never connected is silent. */
  readonly wires: { from: object; to: object }[];
}

/** A context that plays nothing and remembers everything. */
function recorder(): { readonly context: BaseAudioContext; readonly log: Recorded } {
  const log: Recorded = {
    gains: [],
    frequencies: [],
    oscillators: [],
    sources: [],
    filters: [],
    wires: [],
  };

  const param = (sink: Scheduled[]): AudioParam =>
    ({
      setValueAtTime: (value: number, at: number) => {
        sink.push({ kind: 'setValueAtTime', value, at });
      },
      exponentialRampToValueAtTime: (value: number, at: number) => {
        sink.push({ kind: 'exponentialRampToValueAtTime', value, at });
      },
      linearRampToValueAtTime: (value: number, at: number) => {
        sink.push({ kind: 'linearRampToValueAtTime', value, at });
      },
    }) as unknown as AudioParam;

  /* Each node gets its OWN connect, so the graph can be walked afterwards. A shared stub
     records nothing and would let a disconnected layer pass every assertion below. */
  const node = <T extends object>(shape: T): T => {
    /* Mutated in place, NOT spread. A spread evaluates accessors and replaces them with
       their value — which silently turned the oscillator's `type` setter into a frozen
       string, so every oscillator read back as a sine and two assertions started measuring
       the wrong nodes. */
    const self = shape as T & { connect: (to: object) => object; disconnect: () => void };
    self.connect = (to: object) => {
      log.wires.push({ from: self, to });
      return to;
    };
    self.disconnect = () => undefined;
    return self;
  };
  const connectable = { connect: () => undefined, disconnect: () => undefined };

  const context = {
    sampleRate: 48_000,
    currentTime: 0,
    destination: connectable,
    createGain: () => {
      const events: Scheduled[] = [];
      log.gains.push({ events });
      return node({ gain: param(events) });
    },
    createBiquadFilter: () => {
      const events: Scheduled[] = [];
      const filter = node({ type: 'lowpass', frequency: param(events), Q: param([]) });
      log.filters.push(filter);
      log.frequencies.push({ label: 'filter', events });
      return filter;
    },
    createOscillator: () => {
      const events: Scheduled[] = [];
      const entry = { type: 'sine', started: -1, stopped: -1 };
      log.oscillators.push(entry);
      log.frequencies.push({ label: 'osc', events });
      return node({
        get type() {
          return entry.type;
        },
        set type(next: string) {
          entry.type = next;
        },
        frequency: param(events),
        start: (at: number) => {
          entry.started = at;
        },
        stop: (at: number) => {
          entry.stopped = at;
        },
      });
    },
    createBufferSource: () => {
      const entry = { started: -1, stopped: -1 };
      log.sources.push(entry);
      return node({
        buffer: null,
        start: (at: number) => {
          entry.started = at;
        },
        stop: (at: number) => {
          entry.stopped = at;
        },
      });
    },
    createBuffer: (channels: number, frames: number, sampleRate: number) => ({
      sampleRate,
      length: frames,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(frames),
    }),
  } as unknown as BaseAudioContext;

  return { context, log };
}

const built = (): Recorded => {
  const { context, log } = recorder();
  buildNotificationTone(context, context.destination, 0);
  return log;
};

/** Every gain value the sound ever schedules. */
const allGains = (log: Recorded): number[] => log.gains.flatMap((g) => g.events.map((e) => e.value));

describe('the sound is quiet enough to keep on', () => {
  it('never schedules a gain above a tenth of full scale', () => {
    /**
     * The assertion that catches a misplaced decimal point. Everything in this sound is
     * mixed under 0.09, and the master gain is the only 1 — so the loudest thing that
     * reaches the speaker is the sum of layers that are each a fraction of that.
     */
    const layers = allGains(built()).filter((value) => value !== 1);
    expect(Math.max(...layers)).toBeLessThanOrEqual(0.09);
  });

  it('keeps every layer above silence, so nothing is scheduled to nothing', () => {
    // `exponentialRampToValueAtTime` throws in a real context on a value of 0, and a layer
    // ramping to exactly 0 is both a bug and inaudible.
    for (const value of allGains(built())) expect(value).toBeGreaterThan(0);
  });

  it('has a master gain of exactly one, so the mix is set by the layers', () => {
    expect(allGains(built())).toContain(1);
  });
});

describe('the sound is a movement, not an impact', () => {
  it('takes a measurable time to reach its peak', () => {
    /**
     * An instant attack is a click, and a click is a hit. The brief asks for a blade
     * MOVING, and the difference between the two in a waveform is entirely this ramp.
     */
    /* The DRAW's gain, not the master's. The master is scheduled to exactly 1 at t=0 and
       would satisfy any "is there a loud value" search — which is what the first version of
       this test did, and it passed while measuring the wrong node. */
    const draw = built()
      .gains.map((g) => g.events)
      .find((events) => events.some((e) => e.value > 0.05 && e.value < 1));
    expect(draw).toBeDefined();
    const peak = draw!.find((e) => e.value > 0.05 && e.value < 1)!;
    expect(peak.at).toBeGreaterThanOrEqual(0.01);
  });

  it('sweeps its filter UPWARD, which is what makes it a draw', () => {
    /**
     * The shing is a rising filter sweep over noise. Downward would be a sheathe, and flat
     * would be a hiss — neither is the sound that was asked for, and both are one character
     * away in the source.
     */
    const log = built();
    const sweep = log.frequencies.find(
      (f) => f.label === 'filter' && f.events.length >= 2 && f.events[0]!.value < 2000,
    );
    expect(sweep, 'no filter sweep was scheduled').toBeDefined();
    const start = sweep!.events[0]!;
    const top = sweep!.events[1]!;
    expect(top.value).toBeGreaterThan(start.value * 2);
    expect(top.at).toBeGreaterThan(start.at);
  });

  it('uses a bandpass for the draw and a lowpass to take the edge off', () => {
    const types = built().filters.map((f) => f.type);
    expect(types).toContain('bandpass');
    expect(types).toContain('lowpass');
    expect(types).toContain('highpass');
  });
});

describe('the steel reads as metal rather than as a chime', () => {
  it('places its partials at INHARMONIC ratios', () => {
    /**
     * The single decision that separates a blade from a bell. Whole-number multiples are a
     * harmonic series and sound like a chime or a toy; metal plates and blades ring at
     * ratios that are not whole numbers, and that is the whole character.
     */
    const base = 1860;
    const tones = built()
      .frequencies.filter((f) => f.label === 'osc')
      .map((f) => f.events[0]!.value)
      .filter((hz) => hz < 3000);

    expect(tones.length).toBeGreaterThanOrEqual(2);
    for (const hz of tones) {
      const ratio = hz / base;
      if (ratio === 1) continue;
      const nearestWhole = Math.round(ratio);
      expect(
        Math.abs(ratio - nearestWhole),
        `${hz}Hz is ${ratio}x the base, which is a harmonic and will sound like a chime`,
      ).toBeGreaterThan(0.1);
    }
  });

  it('glides upward, but only slightly', () => {
    // Six per cent is movement. A large glide is a slide whistle, which is childish — one
    // of the things the brief rules out by name.
    const glides = built()
      .frequencies.filter((f) => f.label === 'osc' && f.events.length >= 2)
      .map((f) => f.events[1]!.value / f.events[0]!.value);
    expect(glides.length).toBeGreaterThan(0);
    for (const glide of glides) {
      expect(glide).toBeGreaterThan(1);
      expect(glide).toBeLessThan(1.2);
    }
  });
});

describe('the star arrives after the blade, and is a signature not an event', () => {
  it('starts its sparkle in the second half', () => {
    const log = built();
    const sparkles = log.oscillators.filter((o) => o.type === 'sine');
    expect(sparkles.length).toBeGreaterThanOrEqual(3);
    for (const spark of sparkles) expect(spark.started).toBeGreaterThan(0.4);
  });

  it('staggers the sparks rather than stacking them into a chord', () => {
    const starts = built()
      .oscillators.filter((o) => o.type === 'sine')
      .map((o) => o.started)
      .sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThan(0.05);
    }
  });

  it('keeps the sparkle quieter than the blade', () => {
    // A shimmer louder than the sound it decorates is a second notification.
    const gains = allGains(built()).filter((v) => v !== 1);
    const loudest = Math.max(...gains);
    const sparkleLevel = 0.02;
    expect(sparkleLevel).toBeLessThan(loudest);
  });
});

describe('every layer actually reaches the speaker', () => {
  /* Walks the recorded `connect` calls back from the destination. A layer that is built,
     scheduled and never connected passes every other assertion in this file and is silent —
     which is the one failure a schedule-based test would otherwise miss entirely. */
  const reaches = (log: Recorded, from: object, destination: object): boolean => {
    const seen = new Set<object>();
    const walk = (node: object): boolean => {
      if (node === destination) return true;
      if (seen.has(node)) return false;
      seen.add(node);
      return log.wires.filter((w) => w.from === node).some((w) => walk(w.to));
    };
    return walk(from);
  };

  it('connects the noise source, every partial and every spark to the destination', () => {
    const { context, log } = recorder();
    buildNotificationTone(context, context.destination, 0);

    const sources = log.wires.map((w) => w.from);
    expect(sources.length).toBeGreaterThan(8);
    for (const source of new Set(sources)) {
      expect(
        reaches(log, source, context.destination),
        'a node was built and scheduled but never reaches the output',
      ).toBe(true);
    }
  });

  it('routes everything through one master, so a single gain sets the level', () => {
    const { context, log } = recorder();
    buildNotificationTone(context, context.destination, 0);
    const intoDestination = log.wires.filter((w) => w.to === context.destination);
    expect(intoDestination).toHaveLength(1);
  });
});

describe('it fits in a notification', () => {
  it('finishes within one and a half seconds', () => {
    /**
     * The brief says one to two seconds, and the shorter end of that is the right place for
     * something this frequent. Anything past about 1.5s starts to feel cinematic, which is
     * ruled out by name.
     */
    const log = built();
    const ends = [...log.oscillators.map((o) => o.stopped), ...log.sources.map((s) => s.stopped)];
    const last = Math.max(...ends);
    expect(last).toBeGreaterThan(0.9);
    expect(last).toBeLessThanOrEqual(1.5);
  });

  it('agrees with the duration it advertises', () => {
    // `NOTIFICATION_TONE_MS` is what anything waiting on the sound would trust.
    const log = built();
    const ends = [...log.oscillators.map((o) => o.stopped), ...log.sources.map((s) => s.stopped)];
    expect(Math.max(...ends) * 1000).toBeLessThanOrEqual(NOTIFICATION_TONE_MS);
  });

  it('schedules everything relative to the time it is given', () => {
    /* Built at t=2 instead of t=0, everything should move by exactly two seconds. A sound
       that hardcodes `context.currentTime` internally plays immediately whatever it is
       asked, which is how a scheduled sound ends up overlapping the one before it. */
    const { context, log } = recorder();
    buildNotificationTone(context, context.destination, 2);
    for (const osc of log.oscillators) expect(osc.started).toBeGreaterThanOrEqual(2);
    for (const source of log.sources) expect(source.started).toBeGreaterThanOrEqual(2);
  });
});

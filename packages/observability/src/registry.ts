/**
 * The in-process metric registry, and its Prometheus text rendering.
 *
 * `metrics.ts` next door is a CATALOGUE — names, kinds and help strings, declared once
 * so that code and `infrastructure/monitoring/alerts.yml` refer to the same things. It
 * holds no values. Until this file existed, nothing did: the alert on
 * `starlink_inactive_owner_open_conversations > 0` referred to a metric that was
 * defined, documented, alerted on, and never emitted. An alert on a series that never
 * appears does not fire — it is silence that looks like health, which is the failure
 * mode §32.3's zero-target exists to prevent.
 *
 * Deliberately small, and deliberately not `prom-client`:
 *
 *   * Only what is used is here — a gauge that is set, a counter that is added to, and
 *     (since 2026-08-29) a histogram that is observed. Histograms were deferred with the
 *     note that "pretending to support them now would produce a series with no
 *     observations, which is the same lie in a different shape"; that deferral was to
 *     Phase 12, and this is it. Five latency metrics were unemittable until then,
 *     including NFR-PRF-2's send acknowledgement — so `SendAckLatencyBreach`, which reads
 *     `histogram_quantile` over its buckets, watched a series that could not exist.
 *   * A metric must be in the catalogue to be recorded. `set()` and `increment()` take
 *     a `MetricDefinition`, not a string, so a typo is a compile error rather than a
 *     series nobody queries.
 *
 * Values live in memory and are therefore per-process. That is correct for a scrape
 * model: Prometheus pulls from each instance and aggregates. It is also why the
 * inactive-owner gauge is written by a SWEEP rather than incremented at deactivation
 * time — a gauge maintained by events drifts on restart, while one recomputed from a
 * query cannot.
 */
import type { MetricDefinition } from './metrics.js';

type LabelValues = Readonly<Record<string, string>>;

interface Sample {
  readonly definition: MetricDefinition;
  readonly labels: LabelValues;
  value: number;
  /**
   * Histogram state. Absent for gauges and counters.
   *
   * `counts` is per bucket boundary and CUMULATIVE at render time rather than at
   * observation time — Prometheus expects `le` buckets to be cumulative, and summing on
   * the way out means an observation is one array write instead of a loop over every
   * boundary above it.
   */
  histogram?: { counts: number[]; sum: number; count: number };
}

/** Stable, so a scrape does not reorder series between polls for no reason. */
const keyFor = (name: string, labels: LabelValues): string => {
  const pairs = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]!}`)
    .join(',');
  return pairs === '' ? name : `${name}{${pairs}}`;
};

/** Prometheus escaping for a label VALUE: backslash, quote, newline. */
const escapeLabel = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export class MetricRegistry {
  readonly #samples = new Map<string, Sample>();

  /**
   * Sets a gauge. Last write wins, which is what a gauge means.
   *
   * Rejects anything that is not a gauge: a counter that can be set is a counter that
   * can go backwards, and `rate()` over a counter that went backwards reads as a
   * restart. Failing here is better than a wrong graph.
   */
  set(definition: MetricDefinition, value: number, labels: LabelValues = {}): void {
    if (definition.kind !== 'gauge') {
      throw new Error(`${definition.name} is a ${definition.kind}; only a gauge can be set`);
    }
    this.#record(definition, labels).value = value;
  }

  /** Adds to a counter. Monotonic by construction — there is no way to decrease one. */
  increment(definition: MetricDefinition, by = 1, labels: LabelValues = {}): void {
    if (definition.kind !== 'counter') {
      throw new Error(`${definition.name} is a ${definition.kind}; only a counter can be incremented`);
    }
    if (by < 0) {
      throw new Error(`${definition.name} cannot decrease; a counter that goes backwards reads as a restart`);
    }
    this.#record(definition, labels).value += by;
  }

  /**
   * Records one observation against a histogram (§32.4's latency alerts, NFR-PRF-2).
   *
   * Rejects a non-histogram for the same reason `set` rejects a counter: a latency
   * recorded onto a gauge is last-write-wins, so the graph would show whatever the most
   * recent request happened to cost and no percentile would be computable from it.
   *
   * A negative duration is rejected rather than clamped. It means the caller subtracted
   * two clocks that are not the same clock — the mistake ADR-025 was written about — and
   * silently recording zero would hide it while making the percentile optimistic.
   */
  observe(definition: MetricDefinition, value: number, labels: LabelValues = {}): void {
    if (definition.kind !== 'histogram') {
      throw new Error(`${definition.name} is a ${definition.kind}; only a histogram can be observed`);
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${definition.name} cannot observe ${value}; a duration is finite and non-negative`);
    }

    const sample = this.#record(definition, labels);
    const boundaries = definition.buckets ?? [];
    sample.histogram ??= { counts: new Array<number>(boundaries.length).fill(0), sum: 0, count: 0 };

    // The lowest bucket whose upper bound this observation falls within. Anything above
    // every boundary is counted only in `+Inf`, which `count` already provides.
    const index = boundaries.findIndex((upper) => value <= upper);
    if (index >= 0) sample.histogram.counts[index]! += 1;
    sample.histogram.sum += value;
    sample.histogram.count += 1;
  }

  /** The current value, for tests and for the admin surface. */
  read(definition: MetricDefinition, labels: LabelValues = {}): number | undefined {
    return this.#samples.get(keyFor(definition.name, labels))?.value;
  }

  /**
   * Prometheus text exposition format 0.0.4.
   *
   * `# HELP` and `# TYPE` are emitted once per metric NAME even when it carries several
   * label sets — repeating them makes the scrape reject the whole payload.
   */
  render(): string {
    const byName = new Map<string, Sample[]>();
    for (const sample of this.#samples.values()) {
      const existing = byName.get(sample.definition.name);
      if (existing === undefined) byName.set(sample.definition.name, [sample]);
      else existing.push(sample);
    }

    const lines: string[] = [];
    for (const [name, samples] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${samples[0]!.definition.help}`);
      lines.push(`# TYPE ${name} ${samples[0]!.definition.kind}`);
      for (const sample of samples) {
        const pairs = Object.keys(sample.labels)
          .sort()
          .map((k) => `${k}="${escapeLabel(sample.labels[k]!)}"`);
        const labels = pairs.join(',');

        if (sample.definition.kind !== 'histogram') {
          lines.push(`${name}${labels === '' ? '' : `{${labels}}`} ${sample.value}`);
          continue;
        }

        /**
         * A histogram renders as three families: cumulative `_bucket` series, a `_sum`
         * and a `_count`. `histogram_quantile` needs all three, and it needs the buckets
         * cumulative — a scrape with per-bucket counts produces a quantile that is
         * silently wrong rather than an error.
         */
        const state = sample.histogram ?? { counts: [], sum: 0, count: 0 };
        const boundaries = sample.definition.buckets ?? [];
        let cumulative = 0;
        for (const [i, upper] of boundaries.entries()) {
          cumulative += state.counts[i] ?? 0;
          const le = [...pairs, `le="${upper}"`].join(',');
          lines.push(`${name}_bucket{${le}} ${cumulative}`);
        }
        // `+Inf` must equal `_count` exactly, or Prometheus rejects the histogram.
        lines.push(`${name}_bucket{${[...pairs, 'le="+Inf"'].join(',')}} ${state.count}`);
        lines.push(`${name}_sum${labels === '' ? '' : `{${labels}}`} ${state.sum}`);
        lines.push(`${name}_count${labels === '' ? '' : `{${labels}}`} ${state.count}`);
      }
    }
    // A trailing newline is required by the format; a scrape of an empty registry is a
    // valid, empty response rather than an error.
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  #record(definition: MetricDefinition, labels: LabelValues): Sample {
    const declared = definition.labels ?? [];
    for (const key of Object.keys(labels)) {
      if (!declared.includes(key)) {
        // A label the catalogue did not declare creates a series the dashboards and
        // alerts do not know about — invisible data, which is worse than none.
        throw new Error(`${definition.name} does not declare a label named "${key}"`);
      }
    }

    const key = keyFor(definition.name, labels);
    const existing = this.#samples.get(key);
    if (existing !== undefined) return existing;
    const created: Sample = { definition, labels, value: 0 };
    this.#samples.set(key, created);
    return created;
  }
}

/**
 * The process-wide registry.
 *
 * A singleton because a scrape endpoint has to see what a sweep on the other side of
 * the process recorded, and threading a registry through every constructor for that is
 * ceremony. Tests that need isolation construct their own `MetricRegistry`.
 */
export const metrics = new MetricRegistry();

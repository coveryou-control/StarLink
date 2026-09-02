/**
 * The registry, and the alert-rule contract it exists to make true.
 *
 * The last test in this file is the important one. `alerts.yml` referenced
 * `starlink_inactive_owner_open_conversations` while nothing in the codebase emitted it,
 * so the alert on §32.3's zero-target could never have fired — silence that reads as
 * health. A catalogue and an alert file that drift apart produce exactly that, and the
 * only thing that catches it is a test that reads both.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_METRIC_NAMES, METRICS } from './metrics.js';
import { MetricRegistry } from './registry.js';

describe('MetricRegistry', () => {
  it('renders a gauge in Prometheus text format', () => {
    const registry = new MetricRegistry();
    registry.set(METRICS.inactiveOwnerConversations, 0);

    expect(registry.render()).toBe(
      '# HELP starlink_inactive_owner_open_conversations Open customer conversations owned by an inactive principal — target zero\n' +
        '# TYPE starlink_inactive_owner_open_conversations gauge\n' +
        'starlink_inactive_owner_open_conversations 0\n',
    );
  });

  it('emits a zero rather than nothing, so the alert has a series to evaluate', () => {
    /**
     * The whole point. `expr: starlink_inactive_owner_open_conversations > 0` over a
     * series that has never appeared evaluates over no data and stays silent — which is
     * indistinguishable from healthy. A zero is a positive statement that the sweep ran
     * and found nothing.
     */
    const registry = new MetricRegistry();
    registry.set(METRICS.inactiveOwnerConversations, 0);

    expect(registry.render()).toContain('starlink_inactive_owner_open_conversations 0');
  });

  it('groups label sets under one HELP and TYPE header', () => {
    // Repeating the header for a second label set makes Prometheus reject the entire
    // scrape, taking every other metric with it.
    const registry = new MetricRegistry();
    registry.set(METRICS.queueDepth, 3, { team: 'renewals', priority: 'NORMAL' });
    registry.set(METRICS.queueDepth, 1, { team: 'claims', priority: 'HIGH' });

    const rendered = registry.render();
    expect(rendered.match(/# TYPE starlink_queue_depth/g)).toHaveLength(1);
    expect(rendered).toContain('starlink_queue_depth{priority="NORMAL",team="renewals"} 3');
  });

  it('refuses a label the catalogue does not declare', () => {
    // An undeclared label creates a series no dashboard or alert queries — data that
    // exists and is never seen.
    const registry = new MetricRegistry();
    expect(() => registry.set(METRICS.queueDepth, 1, { squad: 'renewals' })).toThrow(/does not declare/);
  });

  it('refuses to set a counter, and refuses to decrease one', () => {
    // A counter that can go backwards makes `rate()` read a restart that never happened.
    const registry = new MetricRegistry();
    expect(() => registry.set(METRICS.reservationExpiries, 5)).toThrow(/only a gauge/);
    expect(() => registry.increment(METRICS.reservationExpiries, -1)).toThrow(/cannot decrease/);
  });

  it('accumulates a counter across increments', () => {
    const registry = new MetricRegistry();
    registry.increment(METRICS.reservationExpiries, 2);
    registry.increment(METRICS.reservationExpiries, 3);
    expect(registry.read(METRICS.reservationExpiries)).toBe(5);
  });

  it('renders an empty registry as an empty body rather than failing', () => {
    expect(new MetricRegistry().render()).toBe('');
  });
});

describe('alert rules refer to metrics that exist', () => {
  /**
   * The drift check the catalogue's own header promises: "a metric renamed in code and
   * not in the alert is an alert that silently stops firing."
   *
   * Read literally rather than by parsing PromQL — every `starlink_*` token in the file
   * must be a name the code can emit. A rule naming a series nothing produces is not a
   * rule; it is a comment that looks like one.
   */
  const alertsPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'infrastructure',
    'monitoring',
    'alerts.yml',
  );

  it('names only metrics declared in the catalogue', () => {
    const text = readFileSync(alertsPath, 'utf8');
    const referenced = [...new Set(text.match(/starlink_[a-z0-9_]+/g) ?? [])];

    expect(referenced.length, 'no metric references found — is the path right?').toBeGreaterThan(0);

    // `_total` counters are queried through rate()/increase() under their own name, and
    // histograms through the `_bucket`/`_sum`/`_count` suffixes Prometheus generates.
    const catalogue = new Set(ALL_METRIC_NAMES);
    const unknown = referenced.filter((name) => {
      if (catalogue.has(name)) return false;
      return !['_bucket', '_sum', '_count'].some(
        (suffix) => name.endsWith(suffix) && catalogue.has(name.slice(0, -suffix.length)),
      );
    });

    expect(unknown, 'alerts.yml names metrics the code cannot emit').toEqual([]);
  });
});

describe('histograms (Phase 12 — NFR-PRF-2, §32.4)', () => {
  it('renders cumulative buckets, a sum and a count', () => {
    const registry = new MetricRegistry();
    for (const seconds of [0.02, 0.15, 0.25, 1.5]) {
      registry.observe(METRICS.messageSendAck, seconds);
    }

    const out = registry.render();

    // Cumulative, not per-bucket. `histogram_quantile` over per-bucket counts is
    // silently wrong rather than an error, which is the worst kind of wrong.
    expect(out).toContain('starlink_message_send_ack_seconds_bucket{le="0.01"} 0');
    expect(out).toContain('starlink_message_send_ack_seconds_bucket{le="0.05"} 1');
    expect(out).toContain('starlink_message_send_ack_seconds_bucket{le="0.2"} 2');
    expect(out).toContain('starlink_message_send_ack_seconds_bucket{le="0.3"} 3');
    expect(out).toContain('starlink_message_send_ack_seconds_bucket{le="+Inf"} 4');
    expect(out).toContain('starlink_message_send_ack_seconds_count 4');
    expect(out).toContain('starlink_message_send_ack_seconds_sum 1.92');
    expect(out).toContain('# TYPE starlink_message_send_ack_seconds histogram');
  });

  it('carries the NFR-PRF-2 target as an explicit bucket boundary', () => {
    /**
     * `SendAckLatencyBreach` fires when the p95 crosses 0.3s. Without 0.3 as a boundary
     * the quantile is interpolated across whatever bucket spans it, so the alert would
     * trigger on arithmetic rather than on the SLO.
     */
    expect(METRICS.messageSendAck.buckets).toContain(0.3);
  });

  it('refuses a negative observation rather than clamping it', () => {
    // Two clocks subtracted that are not the same clock — ADR-025's mistake. Recording
    // zero would hide it and make the percentile optimistic.
    const registry = new MetricRegistry();
    expect(() => registry.observe(METRICS.messageSendAck, -0.1)).toThrow(/non-negative/);
  });

  it('refuses to observe something that is not a histogram, and vice versa', () => {
    const registry = new MetricRegistry();
    expect(() => registry.observe(METRICS.queueDepth, 1)).toThrow(/only a histogram/);
    expect(() => registry.set(METRICS.messageSendAck, 1)).toThrow(/only a gauge/);
  });

  it('renders nothing for a histogram nobody observed', () => {
    // The deferral note's own argument: a series with no observations is a lie in a
    // different shape. An untouched histogram must not appear at all.
    expect(new MetricRegistry().render()).toBe('');
  });
});

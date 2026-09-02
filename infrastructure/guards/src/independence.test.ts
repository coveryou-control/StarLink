/**
 * F-6 / golden test G-24 — platform independence (doc §35.5, §36.2).
 *
 * "StarLink must start, authenticate a user, create a conversation, send and read
 *  messages, deliver realtime, notify and audit with NorthStar completely stopped.
 *  This is testable, and the test belongs in the build rather than in a reviewer's
 *  goodwill."
 *
 * Part IV §67 clarifies the boundary: no NorthStar or peer-application dependency;
 * CCS kernel services ARE intentional platform dependencies, but they are reached only
 * through adapters and are never required for conversation correctness.
 *
 * The runtime half of that acceptance test needs the running apps, which arrive in
 * Phase 2+. What is testable today — and is the part that decays silently as code is
 * added — is the STATIC half: that no NorthStar code, configuration, database or host
 * has entered the application. These assertions pass trivially today, which is exactly
 * why they should be locked in now rather than written after the first violation.
 */
import { describe, expect, it } from 'vitest';
import { collectSourceFiles } from './source-scan.js';

const NORTHSTAR_MARKERS = [/northstar/i, /north_star/i, /\bNS_[A-Z]/];

/** Databases belonging to other products. StarLink refuses to open these (§35.4). */
const FOREIGN_DATABASE_PATTERNS = [/northstar_[a-z]+/i, /\bccs_[a-z]+\b/i];

describe('platform independence (§36.2, G-24)', () => {
  /**
   * Shipped code only.
   *
   * Test files legitimately name other platforms as NEGATIVE fixtures — the namespace
   * guard's own suite asserts that `northstar` and `ccs_pro` are refused. Those
   * references are evidence of compliance, not violations of it, and they never reach
   * a deployable artefact. Scanning them would force the guard's own tests to describe
   * the thing they forbid without naming it, which is worse.
   */
  const files = collectSourceFiles().filter(
    (file) => !file.path.startsWith('infrastructure/guards/') && !/\.test\.ts$/.test(file.path),
  );

  it('imports no NorthStar code and references no NorthStar identifier', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const marker of NORTHSTAR_MARKERS) {
        if (marker.test(file.content)) offenders.push(`${file.path}: matches ${marker}`);
      }
    }
    expect(offenders, `NorthStar references in application source:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('connects to no foreign database name', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const pattern of FOREIGN_DATABASE_PATTERNS) {
        if (pattern.test(file.content)) offenders.push(`${file.path}: matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches every external system through an adapter, never directly from the domain', () => {
    // Part IV §67: CCS kernel services are intentional dependencies — but they are
    // consumed through adapters. A provider SDK imported by a domain package would be
    // the coupling that makes the Phase 9/10 cutover a rewrite.
    const providerImports = /from\s+['"](?:@aws-sdk|mongodb|mongoose|axios|node-fetch|@azure|@google-cloud)/;
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.path.startsWith('packages/')) continue;
      if (providerImports.test(file.content)) offenders.push(file.path);
    }
    expect(offenders, `domain packages importing a provider SDK:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps CY Brain off every synchronous path', () => {
    // Part IV §62 and brief §47: if Brain is unavailable, conversation must continue.
    // The only safe way to guarantee that is for no domain package to know it exists.
    const brainReference = /cy[-_ ]?brain/i;
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.path.startsWith('packages/') && !file.path.startsWith('apps/')) continue;
      // Comments explaining the boundary are fine; an import or a URL is not.
      const codeOnly = file.content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*\*.*$/gm, '');
      if (brainReference.test(codeOnly)) offenders.push(file.path);
    }
    expect(offenders).toEqual([]);
  });
});

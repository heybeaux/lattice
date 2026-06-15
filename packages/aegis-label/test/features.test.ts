/**
 * Feature assembler — the §5 leak guard (the linchpin's safety property), the
 * regime counters, taskDepth, prior-failure counting, and the as-of prior wiring.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleFeatures,
  computeRegime,
  readDecisionMeta,
  signalDateOf,
  FeatureLeakError,
  MissingDecisionMetaError,
} from '../src/features.js';
import { zeroPriorSource } from '../src/priors.js';
import type { SonderEventLike } from '../src/types.js';
import {
  BASE_TS,
  decisionEvent,
  decisionMeta,
  outcomeEvent,
  stubPriors,
  tsPlus,
} from './fixtures.js';

describe('assembleFeatures — leak guard (label-spec §5)', () => {
  it('THROWS when a feature-source event post-dates the decision', () => {
    const decision = decisionEvent();
    // A prior event whose timestamp is AFTER the decision = a walk-forward leak.
    const leaky: SonderEventLike = outcomeEvent('future', decision.id, {
      isError: false,
      exit_code: 0,
    });
    leaky.timestamp = tsPlus(60); // strictly after BASE_TS

    expect(() =>
      assembleFeatures({
        decisionEvent: decision,
        priorEvents: [leaky],
        priors: stubPriors,
      }),
    ).toThrow(FeatureLeakError);
  });

  it('does NOT throw when prior events are at/before the decision', () => {
    const decision = decisionEvent();
    const atOrBefore: SonderEventLike = {
      ...outcomeEvent('past', 'root', { isError: false, exit_code: 0 }),
      timestamp: tsPlus(-30),
    };
    expect(() =>
      assembleFeatures({
        decisionEvent: decision,
        priorEvents: [atOrBefore],
        priors: stubPriors,
      }),
    ).not.toThrow();
  });

  it('throws MissingDecisionMetaError when metadata.aegis is absent', () => {
    const decision = decisionEvent({ metadata: {} });
    expect(() =>
      assembleFeatures({
        decisionEvent: decision,
        priorEvents: [],
        priors: stubPriors,
      }),
    ).toThrow(MissingDecisionMetaError);
  });
});

describe('assembleFeatures — feature content', () => {
  it('mirrors the attached Aegis meta and the as-of prior', () => {
    const decision = decisionEvent();
    const row = assembleFeatures({
      decisionEvent: decision,
      priorEvents: [],
      priors: stubPriors,
    });
    expect(row.tool).toBe('Bash');
    expect(row.ruleSeverityMax).toBe('high');
    expect(row.signalDate).toBe('2026-06-14');
    expect(row.histFailRate_toolPath).toBe(0.04);
    expect(row.secsSinceLastFailHere).toBe(86400);
    expect(row.engramPriorN).toBe(37);
  });

  it('uses the zero-prior default when no Engram is wired', () => {
    const row = assembleFeatures({
      decisionEvent: decisionEvent(),
      priorEvents: [],
      priors: zeroPriorSource,
    });
    expect(row.histFailRate_toolPath).toBe(0);
    expect(row.secsSinceLastFailHere).toBeNull();
    expect(row.engramPriorN).toBe(0);
  });

  it('counts prior in-session failures from outcome events', () => {
    const decision = decisionEvent();
    const prior = [
      { ...outcomeEvent('p1', 'root', { isError: true }), timestamp: tsPlus(-90) },
      {
        ...outcomeEvent('p2', 'root', { isError: false, exit_code: 0 }),
        timestamp: tsPlus(-60),
      },
    ];
    const row = assembleFeatures({
      decisionEvent: decision,
      priorEvents: prior,
      priors: stubPriors,
    });
    expect(row.priorFailuresThisSession).toBe(1);
  });

  it('computes taskDepth from the parent_id chain', () => {
    const root: SonderEventLike = {
      ...decisionEvent({ id: 'root' }),
      timestamp: tsPlus(-120),
    };
    const mid: SonderEventLike = {
      ...decisionEvent({ id: 'mid', parent_id: 'root' }),
      timestamp: tsPlus(-60),
    };
    const decision = decisionEvent({ id: 'leaf', parent_id: 'mid' });
    const row = assembleFeatures({
      decisionEvent: decision,
      priorEvents: [root, mid],
      priors: stubPriors,
    });
    expect(row.taskDepth).toBe(2);
  });
});

describe('computeRegime (label-spec §6)', () => {
  it('clean with no recent failures', () => {
    expect(computeRegime([false, false, false])).toBe('clean');
    expect(computeRegime([])).toBe('clean');
  });

  it('thrashing with >=2 failures in the window', () => {
    expect(computeRegime([true, false, true])).toBe('thrashing');
  });

  it('recovering with exactly one recent failure', () => {
    expect(computeRegime([false, true, false])).toBe('recovering');
  });
});

describe('helpers', () => {
  it('signalDateOf takes the date prefix', () => {
    expect(signalDateOf(BASE_TS)).toBe('2026-06-14');
  });

  it('readDecisionMeta returns the stamped block', () => {
    const meta = readDecisionMeta(decisionEvent({}, decisionMeta()));
    expect(meta.tool).toBe('Bash');
  });
});

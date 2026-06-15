/**
 * rollbackProximity — the walk-backward churn signal that gives the predictor a
 * reason to flag a benign-looking command that edits a just-reverted path.
 *
 * Invariants under test:
 *  - cold-start safe: no history / no resources → 0, never throws.
 *  - leak-safe: only PRECEDING in-session events count; the decision's own event
 *    and any later event are never inspected here.
 *  - overlap-gated: a rollback on an UNRELATED path does not fire.
 *  - window-bounded: a rollback older than the lookback window does not fire.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleFeatures,
  computeRollbackProximity,
} from '../src/features.js';
import { zeroPriorSource } from '../src/priors.js';
import type { SonderEventLike } from '../src/types.js';
import { decisionEvent, tsPlus } from './fixtures.js';

/** A rollback action event touching `paths`, timestamped before the decision. */
function rollbackEvent(
  id: string,
  paths: string[],
  offsetSecs: number,
): SonderEventLike {
  return {
    id,
    agent_id: 'rook',
    task_id: 'task-1',
    timestamp: tsPlus(offsetSecs),
    governance: {},
    paths,
    resources: paths,
    payload: {},
    metadata: { kind: 'rollback' },
  };
}

describe('computeRollbackProximity', () => {
  it('cold-start: empty history → 0 (no throw)', () => {
    const decision = decisionEvent();
    expect(computeRollbackProximity(decision, [])).toBe(0);
  });

  it('returns 0 when the decision touches no resources', () => {
    const decision = decisionEvent({ paths: undefined, resources: undefined });
    const prior = rollbackEvent('rb', ['/repo/src/a.ts'], -10);
    expect(computeRollbackProximity(decision, [prior])).toBe(0);
  });

  it('FIRES (1) when a preceding rollback overlaps the decision target', () => {
    // decision edits /repo/src/a.ts; a rollback hit that same path 10s earlier.
    const decision = decisionEvent({ timestamp: tsPlus(0) });
    const prior = rollbackEvent('rb', ['/repo/src/a.ts'], -10);
    expect(computeRollbackProximity(decision, [prior, decision])).toBe(1);
  });

  it('fires on a path-PREFIX overlap (dir reverted, file re-edited)', () => {
    const decision = decisionEvent({
      timestamp: tsPlus(0),
      paths: ['/repo/src/a.ts'],
      resources: ['/repo/src/a.ts'],
    });
    const prior = rollbackEvent('rb', ['/repo/src'], -5);
    expect(computeRollbackProximity(decision, [prior, decision])).toBe(1);
  });

  it('does NOT fire on an unrelated path', () => {
    const decision = decisionEvent({ timestamp: tsPlus(0) });
    const prior = rollbackEvent('rb', ['/repo/other/z.ts'], -10);
    expect(computeRollbackProximity(decision, [prior, decision])).toBe(0);
  });

  it('detects a git-revert command rollback (not just kind:rollback)', () => {
    const decision = decisionEvent({ timestamp: tsPlus(0) });
    const cmdRollback: SonderEventLike = {
      id: 'rb-cmd',
      agent_id: 'rook',
      task_id: 'task-1',
      timestamp: tsPlus(-8),
      governance: {},
      paths: ['/repo/src/a.ts'],
      resources: ['/repo/src/a.ts'],
      payload: {},
      metadata: { command: 'git revert HEAD' },
    };
    expect(computeRollbackProximity(decision, [cmdRollback, decision])).toBe(1);
  });

  it('is window-bounded: a rollback older than windowN events does not fire', () => {
    const decision = decisionEvent({ timestamp: tsPlus(0) });
    const oldRollback = rollbackEvent('rb-old', ['/repo/src/a.ts'], -100);
    // Five benign events between the rollback and the decision push it out of the
    // default 5-event lookback window.
    const filler: SonderEventLike[] = [1, 2, 3, 4, 5].map((n) => ({
      id: `f${n}`,
      agent_id: 'rook',
      task_id: 'task-1',
      timestamp: tsPlus(-50 + n),
      governance: {},
      paths: ['/repo/src/a.ts'],
      resources: ['/repo/src/a.ts'],
      payload: {},
      metadata: {},
    }));
    const prior = [oldRollback, ...filler, decision];
    expect(computeRollbackProximity(decision, prior, 5)).toBe(0);
  });

  it('leak-safe: the decision event itself is never counted as a rollback', () => {
    // Even if the decision were mislabeled kind:rollback, it must not self-fire.
    const decision = decisionEvent({
      timestamp: tsPlus(0),
      metadata: { aegis: {}, kind: 'rollback' } as Record<string, unknown>,
    });
    expect(computeRollbackProximity(decision, [decision])).toBe(0);
  });
});

describe('assembleFeatures — rollbackProximity wiring', () => {
  it('stamps rollbackProximity=1 when a preceding overlapping rollback exists', () => {
    const decision = decisionEvent({ timestamp: tsPlus(0) });
    const prior = rollbackEvent('rb', ['/repo/src/a.ts'], -10);
    const row = assembleFeatures({
      decisionEvent: decision,
      priorEvents: [prior, decision],
      priors: zeroPriorSource,
    });
    expect(row.rollbackProximity).toBe(1);
  });

  it('stamps rollbackProximity=0 in a clean cold-start session', () => {
    const row = assembleFeatures({
      decisionEvent: decisionEvent(),
      priorEvents: [],
      priors: zeroPriorSource,
    });
    expect(row.rollbackProximity).toBe(0);
  });
});

/**
 * REAL-data axis (src/real.ts): scoring binary classification on real
 * `action_failed` labels, the honesty guard that rejects synthetic rows, and the
 * recall-lift headline. Uses a small inline dataset shaped like frozen
 * aegis-label rows (dataSource:'real'); written to a temp JSONL the same way the
 * `real` subcommand consumes one.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDataset,
  runRealBenchmark,
  type FrozenRowLike,
} from '../src/real.js';

function row(over: Partial<FrozenRowLike> & Pick<FrozenRowLike, 'features' | 'action_failed'>): FrozenRowLike {
  return {
    labelReason: null,
    dataSource: 'real',
    decisionEventId: 'evt',
    ...over,
  };
}

/** A failure both engines catch: a critical-severity row that actually failed. */
const criticalFail = row({
  features: {
    tool: 'bash',
    ruleSeverityMax: 'critical',
    sessionHealthRegime: 'clean',
    priorFailuresThisSession: 0,
    histFailRate_toolPath: 0.9,
    pathsTouched: 1,
  },
  action_failed: 1,
  decisionEventId: 'CRIT01',
});

/** A failure ONLY the predictor catches: medium severity (rule floor stays
 *  silent) but a thrashing session + high history push pFailure over the ask
 *  threshold. */
const predictorOnlyFail = row({
  features: {
    tool: 'edit',
    ruleSeverityMax: 'medium',
    sessionHealthRegime: 'thrashing',
    priorFailuresThisSession: 3,
    histFailRate_toolPath: 0.8,
    pathsTouched: 4,
  },
  action_failed: 1,
  decisionEventId: 'PRED01',
});

/**
 * A clean-session, medium-severity rollback failure: zero command-shape risk,
 * not thrashing — the OLD predictor missed it. Only the walk-backward
 * rollbackProximity signal (an overlapping path reverted just before) flags it.
 */
const rollbackChurnFail = row({
  features: {
    tool: 'bash',
    ruleSeverityMax: 'medium',
    sessionHealthRegime: 'clean',
    priorFailuresThisSession: 0,
    histFailRate_toolPath: 0.0,
    pathsTouched: 1,
    rollbackProximity: 1,
  },
  action_failed: 1,
  labelReason: 'rollback',
  decisionEventId: 'RBCHURN1',
});

/** Same shape as the churn fail but WITHOUT proximity — must stay missed. */
const cleanMediumNoChurn = row({
  features: {
    tool: 'bash',
    ruleSeverityMax: 'medium',
    sessionHealthRegime: 'clean',
    priorFailuresThisSession: 0,
    histFailRate_toolPath: 0.0,
    pathsTouched: 1,
  },
  action_failed: 0,
  decisionEventId: 'CLEANMED',
});

/** A clean low-severity row neither engine flags. */
const cleanLow = row({
  features: {
    tool: 'read',
    ruleSeverityMax: 'low',
    sessionHealthRegime: 'clean',
    priorFailuresThisSession: 0,
    histFailRate_toolPath: 0.0,
    pathsTouched: 1,
  },
  action_failed: 0,
  decisionEventId: 'CLEAN1',
});

/** An unknowable row (excluded from scoring). */
const unknowable = row({
  features: {
    tool: 'bash',
    ruleSeverityMax: 'high',
    sessionHealthRegime: 'clean',
    priorFailuresThisSession: 0,
    histFailRate_toolPath: 0.5,
    pathsTouched: 1,
  },
  action_failed: null,
  decisionEventId: 'UNK001',
});

function writeJsonl(rows: FrozenRowLike[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-real-'));
  const p = join(dir, 'ds.jsonl');
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

describe('real-data benchmark axis', () => {
  it('parses a JSONL dataset, skipping blank lines', () => {
    const jsonl = JSON.stringify(criticalFail) + '\n\n' + JSON.stringify(cleanLow) + '\n';
    const rows = parseDataset(jsonl);
    expect(rows).toHaveLength(2);
    expect(rows[0].decisionEventId).toBe('CRIT01');
  });

  it('excludes unknowable rows and counts scored/failures', () => {
    const p = writeJsonl([criticalFail, predictorOnlyFail, cleanLow, unknowable]);
    const r = runRealBenchmark(p);
    rmSync(p, { force: true });
    expect(r.totalRows).toBe(4);
    expect(r.scoredRows).toBe(3);
    expect(r.excludedRows).toBe(1);
    expect(r.actualFailures).toBe(2);
  });

  it('predictive layer catches a failure the rule floor misses (recall lift)', () => {
    const p = writeJsonl([criticalFail, predictorOnlyFail, cleanLow]);
    const r = runRealBenchmark(p);
    rmSync(p, { force: true });

    const regex = r.engines.find((e) => e.engine === 'regex')!;
    const awm = r.engines.find((e) => e.engine === 'regex+awm')!;

    // Rule floor catches only the critical failure, misses the medium one.
    expect(regex.tp).toBe(1);
    expect(regex.fn).toBe(1);
    // Predictor catches both.
    expect(awm.tp).toBe(2);
    expect(awm.fn).toBe(0);

    expect(r.extraFailuresCaught).toBe(1);
    expect(r.recallLift).toBe(1); // recovered 1 of the rule floor's 1 miss
    expect(awm.recall).toBeGreaterThan(regex.recall);
  });

  it('rollbackProximity lets the predictor catch a clean-session rollback the rule floor AND the old thrash signal both miss', () => {
    const p = writeJsonl([rollbackChurnFail, cleanMediumNoChurn]);
    const r = runRealBenchmark(p);
    rmSync(p, { force: true });

    const regex = r.engines.find((e) => e.engine === 'regex')!;
    const awm = r.engines.find((e) => e.engine === 'regex+awm')!;

    // Rule floor: medium severity is below high/critical → never fires. Misses
    // the real failure, and correctly stays silent on the clean row.
    expect(regex.tp).toBe(0);
    expect(regex.fn).toBe(1);

    // Predictor: rollbackProximity=1 escalates the churn row over the threshold,
    // while the otherwise-identical no-churn clean row stays a true negative
    // (no thrash, no proximity → no false positive).
    expect(awm.tp).toBe(1);
    expect(awm.fn).toBe(0);
    expect(awm.fp).toBe(0);
  });

  it('a thrashing session with NO severity and NO rollback churn no longer false-fires (gating)', () => {
    // A benign read in a thrashing session: the OLD blunt thrash signal flagged
    // it (a false positive). Gated thrash + zero proximity → true negative.
    const benignThrashRead = row({
      features: {
        tool: 'read',
        ruleSeverityMax: 'none',
        sessionHealthRegime: 'thrashing',
        priorFailuresThisSession: 3,
        histFailRate_toolPath: 0.0,
        pathsTouched: 1,
      },
      action_failed: 0,
      decisionEventId: 'THRASHRD',
    });
    const p = writeJsonl([benignThrashRead, criticalFail]);
    const r = runRealBenchmark(p);
    rmSync(p, { force: true });
    const awm = r.engines.find((e) => e.engine === 'regex+awm')!;
    expect(awm.fp).toBe(0);
  });

  it('honesty guard throws on any non-real row', () => {
    const synthetic = row({
      features: criticalFail.features,
      action_failed: 1,
      dataSource: 'synthetic',
      decisionEventId: 'SYNTH1',
    });
    const p = writeJsonl([criticalFail, synthetic]);
    expect(() => runRealBenchmark(p)).toThrow(/non-real row/);
    rmSync(p, { force: true });
  });

  it('result is stamped real with the dataset path', () => {
    const p = writeJsonl([criticalFail, cleanLow]);
    const r = runRealBenchmark(p);
    rmSync(p, { force: true });
    expect(r.dataSource).toBe('real');
    expect(r.datasetPath).toBe(p);
  });
});

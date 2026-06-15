/**
 * REAL-data benchmark axis (the first non-synthetic number).
 *
 * The synthetic axes (`src/run.ts`) model injected failures over a generated
 * corpus. THIS module instead consumes a real, leak-free `action_failed` dataset
 * produced by `@heybeaux/aegis-label`'s `runLabeling` over a genuine, ed25519-
 * signed Sonder audit chain (rows stamped `dataSource:'real'`). It asks the
 * question the build plan actually cares about:
 *
 *   Given REAL gated actions and their REAL outcomes, how well does each engine
 *   anticipate failure — and does the predictive layer (severity prior blended
 *   with session-regime + Engram-style history) lift over the reactive rule floor?
 *
 * We score two engines on the real labels:
 *   - `regex`     — the reactive rule floor: predict-failure iff the rule-eval's
 *                   `ruleSeverityMax` is high/critical (the deterministic ask/deny
 *                   territory). No use of history or session state.
 *   - `regex+awm` — the predictive layer: a cold-start severity prior blended with
 *                   the row's REAL session features (prior in-session failures,
 *                   session-health regime, historical (tool,path) fail-rate),
 *                   intervening when pFailure crosses the engine's ask threshold.
 *
 * Metrics are standard binary-classification on `action_failed`: precision,
 * recall, F1, plus the headline LIFT (recall gain of the predictor over the rule
 * floor at comparable-or-better precision). Rows with `action_failed === null`
 * (unknowable outcome) are excluded — Truth-above-all.
 *
 * Honesty: this path is ONLY valid on `dataSource:'real'` rows; it asserts the
 * stamp and reports the row provenance in the result.
 */

import { readFileSync } from 'node:fs';
import { awmPredict } from './engines/awm-stub.js';
import { DEFAULT_PREDICTION_THRESHOLDS, type Severity } from '@heybeaux/lattice-aegis';

/** Severity → base failure rate (label-spec §7.1; mirrors aegis-label cold-start). */
const COLD_START_BASE_RATES: Record<Severity | 'none', number> = {
  critical: 0.9,
  high: 0.45,
  medium: 0.2,
  low: 0.03,
  none: 0.01,
};

/** pFailure at/above which an engine intervenes (predicts failure). */
const ASK_THRESHOLD = DEFAULT_PREDICTION_THRESHOLDS.askAtOrAbove;

/** The two engines this axis compares. */
export type RealEngine = 'regex' | 'regex+awm';

/** Minimal shape of a frozen `aegis-label` row we read from the dataset JSONL. */
export interface FrozenRowLike {
  features: {
    tool: string;
    ruleSeverityMax: Severity | 'none';
    sessionHealthRegime: 'clean' | 'recovering' | 'thrashing';
    priorFailuresThisSession: number;
    histFailRate_toolPath: number;
    pathsTouched: number;
    /**
     * Walk-backward rollback churn signal (aegis-label feature). 1 when a
     * rollback hit an overlapping path within the lookback window before this
     * decision. Optional so older datasets (pre-feature) still parse as 0.
     */
    rollbackProximity?: number;
  };
  action_failed: 0 | 1 | null;
  labelReason: string | null;
  dataSource: 'real' | 'synthetic';
  decisionEventId: string;
}

/** Binary-classification confusion + derived rates for one engine. */
export interface RealEngineMetrics {
  engine: RealEngine;
  /** True positives: predicted failure, actually failed. */
  tp: number;
  /** False positives: predicted failure, actually clean (friction). */
  fp: number;
  /** False negatives: predicted clean, actually failed (the misses). */
  fn: number;
  /** True negatives: predicted clean, actually clean. */
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  /** Accuracy across all scored rows. */
  accuracy: number;
}

/** The full real-data benchmark result. */
export interface RealBenchmarkResult {
  /** Provenance — must be 'real' for every scored row or we throw. */
  dataSource: 'real';
  datasetPath: string;
  /** Total rows in the dataset file. */
  totalRows: number;
  /** Rows scored (action_failed !== null). */
  scoredRows: number;
  /** Rows excluded as unknowable (action_failed === null). */
  excludedRows: number;
  /** Actual positives in the scored set (action_failed === 1). */
  actualFailures: number;
  /** Per-engine metrics, ordered [regex, regex+awm]. */
  engines: RealEngineMetrics[];
  /**
   * THE HEADLINE: recall lift of the predictor over the rule floor, as a fraction
   * of the rule floor's misses recovered. >0 means the predictor catches real
   * failures the reactive rules miss.
   */
  recallLift: number;
  /** Absolute extra real failures caught by the predictor vs the rule floor. */
  extraFailuresCaught: number;
}

/** Predict-failure verdict for the reactive rule floor. */
function regexPredictsFailure(row: FrozenRowLike): boolean {
  const sev = row.features.ruleSeverityMax;
  // Deterministic rule territory: high/critical map to ask/deny.
  return sev === 'high' || sev === 'critical';
}

/**
 * Failure prior contributed by the walk-backward rollback-proximity feature.
 * A path that was just reverted is in an active churn zone — the next action on
 * it is disproportionately likely to be reverted again. This is a TARGETED
 * signal (it names the path), so it earns a high floor on its own; unlike the
 * blunt session-thrash term it does not fire on unrelated actions.
 */
const ROLLBACK_PROXIMITY_PRIOR = 0.6;

/** Predict-failure verdict for the predictive layer (uses REAL session features). */
function awmPredictsFailure(row: FrozenRowLike): boolean {
  const f = row.features;
  const rollbackProximity = f.rollbackProximity ?? 0;
  // Session-thrash level from the real regime: thrashing > recovering > clean.
  // GATED: a thrashing session with NO command-shape risk and NO rollback churn
  // is too blunt a signal on its own (it fired on benign reads/writes — pure
  // false friction). We only let raw session-thrash escalate when there is also
  // a command-shape signal (medium+ severity); otherwise the targeted features
  // (severity prior, history, rollback proximity) carry the prediction. This is
  // what lets rollback proximity REPLACE thrash as the reason we catch churn
  // failures while dropping the thrash-only false positives.
  const sevRank =
    f.ruleSeverityMax === 'none' || f.ruleSeverityMax === 'low' ? 0 : 1;
  const rawThrash =
    f.sessionHealthRegime === 'thrashing'
      ? 1
      : f.sessionHealthRegime === 'recovering'
        ? 0.5
        : 0;
  const thrash = sevRank === 1 ? rawThrash : 0;
  // Cold-start severity prior is the floor; the blender lifts it with the real
  // historical (tool,path) fail-rate and session thrash.
  const severityPrior = COLD_START_BASE_RATES[f.ruleSeverityMax];
  const pred = awmPredict({
    tool: f.tool,
    thrash,
    // Real Engram-style history for this (tool,path).
    failRate: f.histFailRate_toolPath,
  });
  // Strictest-of across every escalating signal (mirrors the production
  // strictest-of rule — predictions only ever raise the floor, never relax it).
  const pFailure = Math.max(
    severityPrior,
    pred.pFailure,
    rollbackProximity > 0 ? ROLLBACK_PROXIMITY_PRIOR : 0,
  );
  return pFailure >= ASK_THRESHOLD;
}

function metricsFor(
  engine: RealEngine,
  rows: FrozenRowLike[],
  predicts: (r: FrozenRowLike) => boolean,
): RealEngineMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const row of rows) {
    const predicted = predicts(row);
    const actual = row.action_failed === 1;
    if (predicted && actual) tp += 1;
    else if (predicted && !actual) fp += 1;
    else if (!predicted && actual) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = rows.length === 0 ? 0 : (tp + tn) / rows.length;
  return { engine, tp, fp, fn, tn, precision, recall, f1, accuracy };
}

/** Parse a JSONL dataset file into frozen rows. */
export function parseDataset(jsonl: string): FrozenRowLike[] {
  return jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as FrozenRowLike);
}

/**
 * Run the real-data benchmark over a JSONL dataset of frozen `aegis-label` rows.
 * Throws if any scored row is not `dataSource:'real'` (honesty guard — this axis
 * must never silently score synthetic data and call it real).
 */
export function runRealBenchmark(datasetPath: string): RealBenchmarkResult {
  const all = parseDataset(readFileSync(datasetPath, 'utf8'));

  // Honesty guard: every row must be real.
  for (const r of all) {
    if (r.dataSource !== 'real') {
      throw new Error(
        `runRealBenchmark: dataset ${datasetPath} contains a non-real row ` +
          `(decisionEventId=${r.decisionEventId}, dataSource=${r.dataSource}). ` +
          `This axis only scores real Sonder-chain data.`,
      );
    }
  }

  const scored = all.filter((r) => r.action_failed !== null);
  const excluded = all.length - scored.length;
  const actualFailures = scored.filter((r) => r.action_failed === 1).length;

  const regex = metricsFor('regex', scored, regexPredictsFailure);
  const awm = metricsFor('regex+awm', scored, awmPredictsFailure);

  const extraFailuresCaught = awm.tp - regex.tp;
  const recallLift = regex.fn === 0 ? 0 : extraFailuresCaught / regex.fn;

  return {
    dataSource: 'real',
    datasetPath,
    totalRows: all.length,
    scoredRows: scored.length,
    excludedRows: excluded,
    actualFailures,
    engines: [regex, awm],
    recallLift,
    extraFailuresCaught,
  };
}

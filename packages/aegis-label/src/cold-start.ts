/**
 * Cold-start priors (scope §4, label-spec §7.1).
 *
 * Until ≥ floor labeled rows accrue, the gate uses the rule-derived prior, not a
 * trained model. `P(failure) = baseRate[ruleSeverityMax]`. This is what lets
 * Aegis degrade gracefully to pure-deterministic-Lattice behavior with zero
 * data. The returned `Prediction` carries `source: 'prior'`.
 */

import type { Prediction, Severity } from './types.js';

/** Severity → base failure rate (label-spec §7.1). 'none' = no rule matched. */
export const COLD_START_BASE_RATES: Record<Severity | 'none', number> = {
  critical: 0.9,
  high: 0.45,
  medium: 0.2,
  low: 0.03,
  none: 0.01,
};

/**
 * Build a cold-start `Prediction` for a given severity. Confidence is fixed low
 * (0.5) — these are pure priors, not data-backed estimates — so a calibrated
 * blender can down-weight them once real labels arrive.
 */
export function coldStartPrior(severity: Severity | 'none'): Prediction {
  return {
    pFailure: COLD_START_BASE_RATES[severity],
    confidence: 0.5,
    source: 'prior',
  };
}

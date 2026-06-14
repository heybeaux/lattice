/**
 * AWM synthetic predictor (config `regex+decode+awm`, spec §2.2 / Phase 4).
 *
 * ⚠️  predictor: SYNTHETIC-STUB — this is NOT a trained model. Real AWM (Phase 4) swaps
 * the scorer; the harness around it (feeding a `Prediction` into `evaluate(opts.prediction)`)
 * is what this proves out. The stub is a calibrated function over two synthetic features:
 *
 *   1. session-thrash level   — how stuck the session is (retry-loop regime).
 *   2. per-(tool,path) historical fail-rate — does this exact action keep failing?
 *
 * Critically, the predictor can only ESCALATE: the engine already enforces strictest-of, so
 * we just feed pFailure and let `evaluate` raise the floor. A low pFailure never relaxes a
 * rule verdict.
 */

import type { Prediction } from '@heybeaux/lattice-aegis';

/** Tracks per-(tool,path) outcomes across a sequence of episodes (the Engram-prior analog). */
export class PriorStore {
  /** key -> { fails, total } */
  private readonly history = new Map<string, { fails: number; total: number }>();

  private key(tool: string, path: string | undefined): string {
    return `${tool}::${path ?? ''}`;
  }

  /** Record an observed outcome for a (tool,path). */
  record(tool: string, path: string | undefined, failed: boolean): void {
    const k = this.key(tool, path);
    const cur = this.history.get(k) ?? { fails: 0, total: 0 };
    cur.total += 1;
    if (failed) cur.fails += 1;
    this.history.set(k, cur);
  }

  /** Historical fail-rate for a (tool,path), or null if never seen. */
  failRate(tool: string, path: string | undefined): number | null {
    const cur = this.history.get(this.key(tool, path));
    if (!cur || cur.total === 0) return null;
    return cur.fails / cur.total;
  }

  /** Number of times a (tool,path) has been observed. */
  count(tool: string, path: string | undefined): number {
    return this.history.get(this.key(tool, path))?.total ?? 0;
  }

  clear(): void {
    this.history.clear();
  }
}

/** Synthetic features the stub scores over. */
export interface AwmFeatures {
  tool: string;
  path?: string;
  /** Session-thrash level in [0,1] (retry-loop regime intensity). */
  thrash: number;
  /** Optional explicit historical fail-rate; if omitted, read from `priors`. */
  failRate?: number;
  priors?: PriorStore;
}

/**
 * Calibrated synthetic scorer. Blends thrash and historical fail-rate into a pFailure.
 * Confidence rises with how much prior evidence we have for this (tool,path) — this is what
 * makes the column improve over a sequence of episodes as the PriorStore fills in.
 */
export function awmPredict(f: AwmFeatures): Prediction {
  const observed = f.priors ? f.priors.count(f.tool, f.path) : 0;
  const histRate =
    f.failRate ?? (f.priors ? f.priors.failRate(f.tool, f.path) : null) ?? 0;

  // Weighted blend: historical fail-rate dominates once we have evidence; thrash is the
  // session-level signal that applies even to never-seen actions.
  const evidenceWeight = Math.min(1, observed / 3); // saturates after ~3 observations
  const pFailure = clamp01(
    0.15 + 0.65 * histRate * evidenceWeight + 0.45 * f.thrash * (1 - 0.4 * evidenceWeight),
  );

  // More prior observations -> more confident prediction.
  const confidence = clamp01(0.3 + 0.5 * evidenceWeight + 0.2 * Math.min(1, f.thrash));

  return { pFailure, confidence, source: 'prior' };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Marker so reports can label the column honestly. */
export const AWM_LABEL = 'predictor: SYNTHETIC-STUB';

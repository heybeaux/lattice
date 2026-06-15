/**
 * Prior sources (label-spec §5).
 *
 * The pipeline reads historical (tool, path-prefix) fail-rates AS-OF a row's
 * `signalDate` through the injected {@link PriorSource} port — never "now",
 * which would leak future outcomes into a past row's prior. Engram is the real
 * backing source in a deployment; this module ships a deterministic zero-prior
 * default so the package is usable (and testable) with no Engram dependency.
 */

import type { PriorResult, PriorSource } from './types.js';

/**
 * The neutral prior: no history known. `histFailRate_toolPath = 0` with
 * `engramPriorN = 0` signals "no data" to a shrinkage-aware blender, which then
 * leans entirely on the rule-derived cold-start prior (see `cold-start.ts`).
 * `secsSinceLastFailHere = null` means "no recorded failure here".
 */
export const ZERO_PRIOR: PriorResult = {
  histFailRate_toolPath: 0,
  secsSinceLastFailHere: null,
  engramPriorN: 0,
};

/**
 * Default `PriorSource` that returns {@link ZERO_PRIOR} for every query. Use
 * this when Engram is unavailable or for cold-start; swap in a real Engram-backed
 * `PriorSource` in production.
 */
export const zeroPriorSource: PriorSource = {
  lookup: () => ZERO_PRIOR,
};

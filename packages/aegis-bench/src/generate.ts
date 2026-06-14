/**
 * Seeded synthetic corpus + episode generator (spec §1, §3.2, §3.3).
 *
 * ALL DATA IS SYNTHETIC. Everything here is driven by a single mulberry32 seed so a run is
 * byte-reproducible. Two products:
 *   1. The safety corpus (regression + adversarial) — these are hand-authored & fixed; the
 *      generator just bundles them (no randomness; deterministic by construction).
 *   2. Episodes — sequences of synthetic tool calls with injected failure modes, used to
 *      measure tool-use quality lift. Episodes ARE seeded random.
 */

import type { ToolCall } from '@heybeaux/lattice-aegis';
import { mulberry32, type Rng } from './prng.js';
import {
  FAILURE_MODES,
  FAILURE_PROFILES,
  type FailureMode,
} from './corpus/taxonomy.js';
import { REGRESSION_CASES, type RegressionCase } from './corpus/regression.js';
import { ADVERSARIAL_CASES, type AdversarialCase } from './corpus/adversarial.js';

/** One synthetic tool call inside an episode. */
export interface EpisodeCall {
  tool: string;
  /** Stable target path (or command key) used for per-(tool,path) prior accumulation. */
  path: string;
  call: ToolCall;
  /**
   * The injected failure mode, or null for a call that succeeds on the first try with no
   * harness. A non-null mode means a raw model (no harness) WILL fail this call.
   */
  injectedFailure: FailureMode | null;
  /** Session-thrash level at this point in the episode, in [0,1]. */
  thrash: number;
}

export interface Episode {
  id: number;
  calls: EpisodeCall[];
}

/** A reusable pool of synthetic (tool, path) action templates. */
const ACTION_POOL: ReadonlyArray<{ tool: string; path: string; mk: (p: string) => ToolCall }> = [
  { tool: 'Write', path: 'src/feature.ts', mk: (p) => ({ tool: 'Write', paths: [p], content: 'export const f = () => 1;' }) },
  { tool: 'Edit', path: 'src/config.ts', mk: (p) => ({ tool: 'Edit', paths: [p], content: 'export const PORT = 3000;' }) },
  { tool: 'Write', path: 'dist/out.js', mk: (p) => ({ tool: 'Write', paths: [p], content: 'module.exports = {};' }) },
  { tool: 'Bash', path: 'npm run build', mk: () => ({ tool: 'Bash', command: 'npm run build' }) },
  { tool: 'Bash', path: 'npm test', mk: () => ({ tool: 'Bash', command: 'npm test' }) },
  { tool: 'Read', path: 'docs/api.md', mk: (p) => ({ tool: 'Read', paths: [p], content: 'API docs.' }) },
  { tool: 'Bash', path: 'git status', mk: () => ({ tool: 'Bash', command: 'git status' }) },
  { tool: 'Edit', path: 'src/router.ts', mk: (p) => ({ tool: 'Edit', paths: [p], content: 'export const routes = [];' }) },
];

/**
 * Generate one episode of `length` calls. A fraction of calls get an injected failure mode,
 * chosen from the taxonomy. Thrash rises when consecutive failures cluster (retry-loop
 * regime), modeling a session getting stuck.
 */
function generateEpisode(rng: Rng, id: number, length: number, failProb: number): Episode {
  const calls: EpisodeCall[] = [];
  let thrash = 0;
  for (let i = 0; i < length; i++) {
    const action = rng.pick(ACTION_POOL);
    const willFail = rng.bool(failProb);
    const mode: FailureMode | null = willFail ? rng.pick(FAILURE_MODES) : null;

    // Thrash accumulates on failure, decays on success (clamped to [0,1]).
    if (mode !== null) thrash = Math.min(1, thrash + 0.25);
    else thrash = Math.max(0, thrash - 0.15);

    calls.push({
      tool: action.tool,
      path: action.path,
      call: action.mk(action.path),
      injectedFailure: mode,
      thrash: Number(thrash.toFixed(4)),
    });
  }
  return { id, calls };
}

/** Generate a sequence of episodes (the "over time" dimension). */
export function generateEpisodes(
  seed: number,
  episodeCount: number,
  opts: { length?: number; failProb?: number } = {},
): Episode[] {
  const rng = mulberry32(seed);
  const length = opts.length ?? 12;
  const failProb = opts.failProb ?? 0.4;
  const episodes: Episode[] = [];
  for (let i = 0; i < episodeCount; i++) {
    episodes.push(generateEpisode(rng, i, length, failProb));
  }
  return episodes;
}

/** Bundle the fixed safety corpus (deterministic, no randomness). */
export interface SafetyCorpus {
  regression: readonly RegressionCase[];
  adversarial: readonly AdversarialCase[];
}

export function safetyCorpus(): SafetyCorpus {
  return { regression: REGRESSION_CASES, adversarial: ADVERSARIAL_CASES };
}

/** Re-export for convenience. */
export { FAILURE_PROFILES };

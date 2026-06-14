/**
 * Tool-use failure taxonomy — the six failure modes the benchmark tracks (spec §3.2).
 * These are the labels that make tool-use quality measurable. Synthetic episodes
 * (src/generate.ts) inject these failure modes into tool-call traces, and the harness
 * configs are scored on how they change the outcome.
 */

/** The six tool-use failure modes (spec §3.2 table). */
export type FailureMode =
  | 'malformed_args'
  | 'wrong_tool'
  | 'permission_denied'
  | 'downstream_error'
  | 'timeout'
  | 'retry_loop';

export const FAILURE_MODES: readonly FailureMode[] = [
  'malformed_args',
  'wrong_tool',
  'permission_denied',
  'downstream_error',
  'timeout',
  'retry_loop',
] as const;

/**
 * What an ideal harness does for each failure mode, and which engine capability
 * is responsible. `preExec` modes are catchable before the call runs (a good harness
 * pre-empts them); `predictive` modes have no rule match and need the AWM backstop.
 */
export interface FailureProfile {
  mode: FailureMode;
  /** Human description of what goes wrong. */
  description: string;
  /** What an ideal harness does (spec §3.2). */
  idealHarnessAction: string;
  /**
   * Which capability can catch this:
   *  - 'rule'      : a deterministic rule-pack match flags it (regex+ all catch).
   *  - 'predictor' : no rule matches; only the AWM predictor can flag it.
   *  - 'regime'    : caught by session-thrash regime (retry loops).
   *  - 'none'      : nothing pre-empts it deterministically (best-effort via predictor).
   */
  caughtBy: 'rule' | 'predictor' | 'regime' | 'none';
  /**
   * Base probability that a raw call (no harness) carrying this intent fails when
   * injected. Used by the episode generator. Deterministic; not random itself.
   */
  baseFailRate: number;
}

export const FAILURE_PROFILES: Record<FailureMode, FailureProfile> = {
  malformed_args: {
    mode: 'malformed_args',
    description: 'invalid JSON / missing required argument',
    idealHarnessAction: 'catch pre-exec, return a fix hint',
    caughtBy: 'rule',
    baseFailRate: 1.0,
  },
  wrong_tool: {
    mode: 'wrong_tool',
    description: 'a tool that cannot satisfy the intent',
    idealHarnessAction: 'suggest the right tool',
    caughtBy: 'rule',
    baseFailRate: 1.0,
  },
  permission_denied: {
    mode: 'permission_denied',
    description: 'tool needs a gate the agent lacks',
    idealHarnessAction: 'ASK instead of letting it hard-fail',
    caughtBy: 'rule',
    baseFailRate: 1.0,
  },
  downstream_error: {
    mode: 'downstream_error',
    description: 'call succeeds but produces a bad downstream event',
    idealHarnessAction: 'flag via predictor (no rule matches)',
    caughtBy: 'predictor',
    baseFailRate: 1.0,
  },
  timeout: {
    mode: 'timeout',
    description: 'long-running op exceeds budget',
    idealHarnessAction: 'governor budget pre-empts',
    caughtBy: 'predictor',
    baseFailRate: 1.0,
  },
  retry_loop: {
    mode: 'retry_loop',
    description: 'same failing call repeated N times',
    idealHarnessAction: 'session-thrash regime tightens/halts',
    caughtBy: 'regime',
    baseFailRate: 1.0,
  },
};

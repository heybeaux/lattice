/**
 * Axis 2 — Tool-use quality lift (the north star, spec §3.2 / §3.3).
 *
 * This is the part nobody else measures. We model an agent running a TASK EPISODE — a
 * sequence of synthetic tool calls, some carrying an injected failure mode — and ask, per
 * config: how does running the calls through Aegis change the trace outcome vs the raw model
 * (`none`)?
 *
 * The model (all synthetic, all deterministic):
 *   - A call with `injectedFailure != null` FAILS under `none` (raw model, no harness).
 *   - A config "saves" that call if it would INTERVENE (deny/ask) on it before it executes.
 *     Which configs can catch which failure modes is governed by `FAILURE_PROFILES[mode].caughtBy`:
 *       'rule'      -> deterministic rule territory; every real config catches it.
 *       'predictor' -> no rule matches; only `+awm`'s prediction can catch it.
 *       'regime'    -> retry-loop / session-thrash; only `+awm`'s regime signal catches it.
 *       'none'      -> nothing pre-empts it deterministically (best-effort via predictor).
 *     For the predictor/regime/none modes the `+awm` save is NOT automatic: we actually run
 *     `awmPredict({tool,path,thrash,priors})` and only count a save when the synthetic
 *     prediction escalates (pFailure crosses the engine's ask threshold). That is what makes
 *     the `+awm` column improve over a SEQUENCE of episodes: as the PriorStore fills in,
 *     pFailure on repeat-offender (tool,path)s rises past the threshold and more calls are saved.
 *   - A FALSE BLOCK = intervening on a call whose `injectedFailure === null` (a good call).
 *     This is the "net friction" cost — the lift must not come from blocking everything.
 *
 * Retries-to-success model: under `none`, a failing call costs `RAW_RETRIES` wasted attempts
 * before (maybe) recovering. A config that SAVES the call pre-empts it for a fixed `SAVED_RETRIES`
 * cost (the harness caught it pre-exec / asked, so the agent fixes it in ~one corrected attempt).
 * Unsaved failing calls keep the raw retry cost.
 *
 * `none` never intervenes, so it saves nothing and has zero false blocks — it is the baseline
 * every other config is measured against.
 */

import type { GateAction, Prediction } from '@heybeaux/lattice-aegis';
import type { Episode, EpisodeCall } from '../generate.js';
import type { ConfigName } from '../engines/regex.js';
import { FAILURE_PROFILES, type FailureMode } from '../corpus/taxonomy.js';
import { PriorStore, awmPredict } from '../engines/awm-stub.js';
import { DEFAULT_PREDICTION_THRESHOLDS } from '@heybeaux/lattice-aegis';

/** Wasted attempts a raw (unsaved) failing call burns before the agent gives up/recovers. */
const RAW_RETRIES = 3;
/** Attempts a saved call costs — the harness pre-empted it, agent corrects in ~one shot. */
const SAVED_RETRIES = 1;
/** A thrash episode is a stretch of >= this many consecutive failing calls (a retry loop). */
const THRASH_RUN = 3;
/** pFailure at/above which the engine intervenes (ask). Mirrors the aegis default. */
const ASK_THRESHOLD = DEFAULT_PREDICTION_THRESHOLDS.askAtOrAbove;

/** Per-config tool-use lift metrics (spec §3.2). All rates in [0,1]; counts are integers. */
export interface ToolUseMetrics {
  config: ConfigName;
  /** Total calls scored across all episodes. */
  totalCalls: number;
  /** Calls that carried an injected failure (would fail under `none`). */
  injectedFailures: number;
  /** Calls that reach a good outcome under this config (saved failures + clean calls). */
  successfulCalls: number;
  /** Fraction of calls that reach a good outcome. */
  successRate: number;
  /** Calls that still fail under this config (injected failures this config could not save). */
  failedCalls: number;
  /** Failed-call RATE = failedCalls / totalCalls (the curve that must bend down). */
  failedCallRate: number;
  /**
   * THE HEADLINE: reduction in failed calls vs the `none` baseline, as a fraction of the
   * baseline's failed calls. 0 for `none`; rises toward 1 as configs save more.
   */
  failedCallReduction: number;
  /** Mean retries-to-success over all calls (lower = faster recovery). */
  meanRetriesToSuccess: number;
  /** Count of thrash episodes (retry loops) this config cut short via a save in the run. */
  thrashEpisodesAvoided: number;
  /** Wasted-action cost = sum of retries a perfect harness would have pre-empted. */
  wastedActionCost: number;
  /** Net friction: false blocks on GOOD calls (injectedFailure === null). Must stay low. */
  falseBlocks: number;
  /** False-block rate over all good calls. */
  falseBlockRate: number;
}

/** One point on the "lift over episodes seen" curve (spec §3.3). */
export interface OverTimePoint {
  /** 0-based episode index in the sequence. */
  episodeIndex: number;
  /** Failed-call rate within this single episode under the config. */
  failedCallRate: number;
  /** Cumulative failed-call rate over episodes [0..episodeIndex] (the smoothed slope). */
  cumulativeFailedCallRate: number;
}

/** Full Axis-2 result for one config: aggregate metrics + the over-time series. */
export interface ToolUseResult {
  metrics: ToolUseMetrics;
  /** Per-episode series; for `+awm` this should slope DOWN as priors accumulate. */
  overTime: OverTimePoint[];
}

/** The per-call decision a config makes (internal to scoring; exposed for tests). */
export interface CallOutcome {
  injected: FailureMode | null;
  /** Did the config intervene (deny/ask) on this call? */
  intervened: boolean;
  /** Did the call ultimately fail under this config? */
  failed: boolean;
  /** True when intervening on a GOOD call (false block). */
  falseBlock: boolean;
  /** Retries this call cost. */
  retries: number;
}

/**
 * Decide whether `config` saves a failing call carrying `mode`. For rule-catchable modes
 * every real config catches it. For predictor/regime/none modes, only `+awm` catches it, and
 * only when the synthetic prediction actually escalates given the current priors + thrash.
 */
function configSaves(
  config: ConfigName,
  call: EpisodeCall,
  mode: FailureMode,
  priors: PriorStore,
): boolean {
  if (config === 'none') return false;
  const caughtBy = FAILURE_PROFILES[mode].caughtBy;

  if (caughtBy === 'rule') {
    // Deterministic rule territory: regex, regex+decode, regex+decode+awm all catch it.
    return true;
  }

  // predictor / regime / none modes: only the AWM column has a shot, via the predictor.
  if (config !== 'regex+decode+awm') return false;
  const prediction: Prediction = awmPredict({
    tool: call.tool,
    path: call.path,
    thrash: call.thrash,
    priors,
  });
  return predictionIntervenes(prediction.pFailure);
}

/** Whether a synthetic prediction crosses the engine's intervene (ask) threshold. */
export function predictionIntervenes(pFailure: number): boolean {
  return pFailure >= ASK_THRESHOLD;
}

/**
 * For a GOOD call (no injected failure), the `+awm` predictor can still fire a FALSE BLOCK if
 * its synthetic pFailure crosses the threshold (e.g. a clean call inside a high-thrash session,
 * or a (tool,path) with a noisy prior). regex / regex+decode never false-block on these benign
 * synthetic actions (they carry no dangerous rule match). `none` never intervenes.
 */
function configFalseBlocks(
  config: ConfigName,
  call: EpisodeCall,
  priors: PriorStore,
): boolean {
  if (config !== 'regex+decode+awm') return false;
  const prediction = awmPredict({
    tool: call.tool,
    path: call.path,
    thrash: call.thrash,
    priors,
  });
  return predictionIntervenes(prediction.pFailure);
}

/** Score one call under one config given the (sequential) prior store. */
function scoreCall(
  config: ConfigName,
  call: EpisodeCall,
  priors: PriorStore,
): CallOutcome {
  const mode = call.injectedFailure;

  if (mode === null) {
    // Good call. Only a false block can spoil it.
    const falseBlock = configFalseBlocks(config, call, priors);
    return {
      injected: null,
      intervened: falseBlock,
      failed: false, // a good call never "fails" — a false block is friction, not failure
      falseBlock,
      retries: SAVED_RETRIES,
    };
  }

  // Failing call. Saved => pre-empted (low cost); unsaved => raw retry burn.
  const saved = configSaves(config, call, mode, priors);
  return {
    injected: mode,
    intervened: saved,
    failed: !saved,
    falseBlock: false,
    retries: saved ? SAVED_RETRIES : RAW_RETRIES,
  };
}

/** Count thrash runs (>= THRASH_RUN consecutive injected failures) in an episode. */
function thrashRunsIn(calls: readonly EpisodeCall[]): number {
  let runs = 0;
  let streak = 0;
  for (const c of calls) {
    if (c.injectedFailure !== null) {
      streak += 1;
      if (streak === THRASH_RUN) runs += 1; // count each distinct loop once when it forms
    } else {
      streak = 0;
    }
  }
  return runs;
}

/**
 * Score Axis 2 for a single config across the episode sequence. The PriorStore accumulates
 * IN SEQUENCE: each call's outcome is recorded AFTER it is scored, so later episodes see the
 * fuller history and the `+awm` column catches more — the "improve over time" proof.
 */
export function scoreConfigToolUse(
  config: ConfigName,
  episodes: readonly Episode[],
): ToolUseResult {
  const priors = new PriorStore();

  let totalCalls = 0;
  let injectedFailures = 0;
  let failedCalls = 0;
  let falseBlocks = 0;
  let goodCalls = 0;
  let totalRetries = 0;
  let wastedActionCost = 0;
  let thrashEpisodesAvoided = 0;

  const overTime: OverTimePoint[] = [];
  let cumCalls = 0;
  let cumFailed = 0;

  for (const ep of episodes) {
    let epCalls = 0;
    let epFailed = 0;
    let epThrashSavedAny = false;

    for (const call of ep.calls) {
      const outcome = scoreCall(config, call, priors);

      totalCalls += 1;
      epCalls += 1;
      totalRetries += outcome.retries;

      if (outcome.injected !== null) {
        injectedFailures += 1;
        if (outcome.failed) {
          failedCalls += 1;
          epFailed += 1;
          // Wasted = the retries a perfect harness would have pre-empted on an unsaved fail.
          wastedActionCost += outcome.retries - SAVED_RETRIES;
        } else if (FAILURE_PROFILES[outcome.injected].caughtBy === 'regime') {
          // A saved retry-loop call means the regime gate cut a thrash loop short.
          epThrashSavedAny = true;
        }
      } else {
        goodCalls += 1;
        if (outcome.falseBlock) falseBlocks += 1;
      }

      // Record the GROUND-TRUTH outcome (did the raw call carry a failure?) into the priors,
      // so the predictor learns per-(tool,path) fail-history over the sequence.
      priors.record(call.tool, call.path, call.injectedFailure !== null);
    }

    // A thrash episode is "avoided" if this episode contained a retry loop AND the config
    // saved at least one of its loop calls.
    if (epThrashSavedAny && thrashRunsIn(ep.calls) > 0) {
      thrashEpisodesAvoided += thrashRunsIn(ep.calls);
    }

    cumCalls += epCalls;
    cumFailed += epFailed;
    overTime.push({
      episodeIndex: ep.id,
      failedCallRate: epCalls === 0 ? 0 : epFailed / epCalls,
      cumulativeFailedCallRate: cumCalls === 0 ? 0 : cumFailed / cumCalls,
    });
  }

  const successfulCalls = totalCalls - failedCalls;
  const metrics: ToolUseMetrics = {
    config,
    totalCalls,
    injectedFailures,
    successfulCalls,
    successRate: totalCalls === 0 ? 0 : successfulCalls / totalCalls,
    failedCalls,
    failedCallRate: totalCalls === 0 ? 0 : failedCalls / totalCalls,
    failedCallReduction: 0, // filled in by scoreToolUse once the `none` baseline is known
    meanRetriesToSuccess: totalCalls === 0 ? 0 : totalRetries / totalCalls,
    thrashEpisodesAvoided,
    wastedActionCost,
    falseBlocks,
    falseBlockRate: goodCalls === 0 ? 0 : falseBlocks / goodCalls,
  };

  return { metrics, overTime };
}

/**
 * Score Axis 2 for every config over the same episode sequence, then fill in each config's
 * `failedCallReduction` relative to the `none` baseline (the headline number). Configs are
 * scored in the given order; the result map preserves that order for stable reporting.
 */
export function scoreToolUse(
  configs: readonly ConfigName[],
  episodes: readonly Episode[],
): Map<ConfigName, ToolUseResult> {
  const results = new Map<ConfigName, ToolUseResult>();
  for (const config of configs) {
    results.set(config, scoreConfigToolUse(config, episodes));
  }

  const baseline = results.get('none');
  const baselineFailed = baseline ? baseline.metrics.failedCalls : 0;
  for (const result of results.values()) {
    result.metrics.failedCallReduction =
      baselineFailed === 0
        ? 0
        : (baselineFailed - result.metrics.failedCalls) / baselineFailed;
  }

  return results;
}

/** Re-export the action type for callers building tables. */
export type { GateAction };

/**
 * Benchmark orchestrator (spec §3, §4). Runs BOTH axes over the synthetic corpora and the
 * seeded episode sequence, and returns ONE byte-stable `BenchmarkResult`.
 *
 * Axis 1 (safety floor): score the regression + adversarial corpus under each REAL config,
 *   timing every `evaluate` call for latency percentiles.
 * Axis 2 (tool-use lift): generate episodes and run the lift scoring across `none` + the real
 *   configs, with a PriorStore accumulating IN SEQUENCE per config (the "over time" proof).
 *
 * Determinism contract: nothing in the SCORED output may depend on wall-clock or Map-iteration
 * order. The timestamp is a FIXED string (`'SYNTHETIC'` by default) — we never call Date.now()
 * in the scored result. Latency numbers ARE wall-clock measured but are reported separately and
 * excluded from the determinism diff via the report layer's rounding... see note below.
 *
 * NOTE on latency + determinism: per-eval latency is genuinely wall-clock and therefore NOT
 * byte-stable. To keep `--seed 42` reproducible we DO NOT put raw latency into the determinism
 * surface: latency is recorded but the JSON determinism check in the DoD compares the
 * `--format json` output, which the report layer emits with latency fields ROUNDED OUT (set to
 * a stable sentinel). The structural/metric numbers (the actual benchmark result) are fully
 * deterministic. See report.ts `toJSON`.
 */

import { safetyCorpus } from './generate.js';
import { generateEpisodes } from './generate.js';
import {
  loadAllRules,
  evalRegex,
  evalRegexDecode,
  evalRegexDecodeAwm,
  REAL_CONFIGS,
  ALL_CONFIGS,
  type ConfigName,
} from './engines/regex.js';
import { awmPredict } from './engines/awm-stub.js';
import {
  safetyMetrics,
  type ScoredCase,
  type SafetyMetrics,
} from './score/safety.js';
import {
  scoreToolUse,
  type ToolUseResult,
} from './score/tooluse.js';
import type { CompiledRule, Evaluation, GateAction, Prediction } from '@heybeaux/lattice-aegis';
import type { AdversarialCase } from './corpus/adversarial.js';
import type { RegressionCase } from './corpus/regression.js';

/** Honesty flags carried in every result (spec §1). */
export interface HonestyFlags {
  /** Always SYNTHETIC for v1 (no Sonder audit chain yet). */
  dataSource: 'SYNTHETIC';
  /** The required header string. */
  dataHeader: string;
  /** The required predictor-column label. */
  predictorLabel: string;
}

export const HONESTY: HonestyFlags = {
  dataSource: 'SYNTHETIC',
  dataHeader: 'DATA: SYNTHETIC (no Sonder audit chain yet)',
  predictorLabel: 'predictor: SYNTHETIC-STUB',
};

export interface BenchmarkMetadata {
  seed: number;
  episodes: number;
  /** FIXED deterministic stamp by default (`'SYNTHETIC'`). Override only for ad-hoc runs. */
  timestamp: string;
  /** Engine configs scored on the safety axis (the real ones). */
  safetyConfigs: ConfigName[];
  /** Engine configs scored on the tool-use axis (`none` + real). */
  toolUseConfigs: ConfigName[];
}

/** Axis-1 result: confusion + latency per config, split by corpus for diagnostics. */
export interface SafetyResult {
  config: ConfigName;
  /** Metrics over the combined regression + adversarial corpus. */
  overall: SafetyMetrics;
  /** Regression-floor only (the must-not-regress sub-score). */
  regression: SafetyMetrics;
  /** Adversarial value-proof only (where +decode / +awm earn their keep). */
  adversarial: SafetyMetrics;
}

export interface BenchmarkResult {
  metadata: BenchmarkMetadata;
  honesty: HonestyFlags;
  /** Axis 1 — safety confusion per config (ordered like safetyConfigs). */
  safety: SafetyResult[];
  /** Axis 2 — tool-use lift per config (ordered like toolUseConfigs). */
  toolUse: ToolUseResult[];
}

export interface RunOptions {
  seed: number;
  episodes: number;
  /** Optional fixed timestamp; defaults to `'SYNTHETIC'` to keep output byte-stable. */
  now?: string;
}

/** Run one config's engine against a single tool call, returning the verdict. */
function evaluateUnderConfig(
  config: ConfigName,
  call: RegressionCase['input'],
  rules: CompiledRule[],
  prediction: Prediction | undefined,
): Evaluation {
  switch (config) {
    case 'none':
      // `none` never intervenes — pass everything (raw model). Not used on Axis 1, but kept
      // total for type-safety.
      return {
        action: 'allow',
        decidedBy: 'severity',
        matches: [],
        reason: 'none baseline: no harness',
        ruleVersions: [],
      };
    case 'regex':
      return evalRegex(call, rules);
    case 'regex+decode':
      return evalRegexDecode(call, rules);
    case 'regex+decode+awm':
      return evalRegexDecodeAwm(call, rules, prediction);
  }
}

/**
 * Build the synthetic prediction for an adversarial novel-but-doomed case under `+awm`.
 * Uses the case's `predictorHint` (a failing path => high historical fail-rate; a thrash
 * level => session-regime signal) to drive `awmPredict`. Returns undefined when there is no
 * hint (so the predictor contributes nothing and the rule floor stands).
 */
function predictionForAdversarial(
  config: ConfigName,
  c: AdversarialCase,
): Prediction | undefined {
  if (config !== 'regex+decode+awm') return undefined;
  if (!c.predictorHint) return undefined;
  const thrash = c.predictorHint.thrash ?? 0;
  // A path that "failed 3x this session" => historical fail-rate of 1.0 with strong evidence.
  const failRate = c.predictorHint.failingPath ? 1 : 0;
  return awmPredict({ tool: c.input.tool, path: c.predictorHint.failingPath ?? '', thrash, failRate });
}

/** Score the safety corpus (regression + adversarial) under one real config. */
function scoreSafetyConfig(
  config: ConfigName,
  regression: readonly RegressionCase[],
  adversarial: readonly AdversarialCase[],
  rules: CompiledRule[],
): SafetyResult {
  const regScored: ScoredCase[] = [];
  for (const c of regression) {
    const { evaluation, latencyMs } = timedEvaluate(() =>
      evaluateUnderConfig(config, c.input, rules, undefined),
    );
    regScored.push({
      id: c.id,
      expected: c.expectedVerdict,
      actual: evaluation.action,
      latencyMs,
    });
  }

  const advScored: ScoredCase[] = [];
  for (const c of adversarial) {
    const prediction = predictionForAdversarial(config, c);
    const { evaluation, latencyMs } = timedEvaluate(() =>
      evaluateUnderConfig(config, c.input, rules, prediction),
    );
    advScored.push({
      id: c.id,
      expected: c.expectedVerdict,
      actual: evaluation.action,
      latencyMs,
    });
  }

  return {
    config,
    overall: safetyMetrics([...regScored, ...advScored]),
    regression: safetyMetrics(regScored),
    adversarial: safetyMetrics(advScored),
  };
}

/** Time a single evaluation in milliseconds (high-resolution). */
function timedEvaluate(fn: () => Evaluation): { evaluation: Evaluation; latencyMs: number } {
  const start = performance.now();
  const evaluation = fn();
  const latencyMs = performance.now() - start;
  return { evaluation, latencyMs };
}

/**
 * Run the full benchmark: both axes, all configs, one typed result. Deterministic in every
 * field except the wall-clock latency numbers (which the report layer stabilises for diffs).
 */
export function runBenchmark(opts: RunOptions): BenchmarkResult {
  const rules = loadAllRules();
  const { regression, adversarial } = safetyCorpus();

  // ---- Axis 1: safety floor ----
  const safety: SafetyResult[] = REAL_CONFIGS.map((config) =>
    scoreSafetyConfig(config, regression, adversarial, rules),
  );

  // ---- Axis 2: tool-use lift ----
  const episodes = generateEpisodes(opts.seed, opts.episodes);
  const toolUseMap = scoreToolUse(ALL_CONFIGS, episodes);
  const toolUse: ToolUseResult[] = ALL_CONFIGS.map((config) => {
    const r = toolUseMap.get(config);
    if (!r) throw new Error(`missing tool-use result for config ${config}`);
    return r;
  });

  const metadata: BenchmarkMetadata = {
    seed: opts.seed,
    episodes: opts.episodes,
    timestamp: opts.now ?? 'SYNTHETIC',
    safetyConfigs: [...REAL_CONFIGS],
    toolUseConfigs: [...ALL_CONFIGS],
  };

  return { metadata, honesty: HONESTY, safety, toolUse };
}

/** Re-export the verdict type for report tables. */
export type { GateAction };

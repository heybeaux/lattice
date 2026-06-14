/**
 * @heybeaux/aegis-bench — public API.
 *
 * The first benchmark that measures whether an agent harness improves tool use OVER TIME
 * (fewer failed calls, faster recovery, less thrash), not just whether it blocks bad commands.
 * Scores @heybeaux/lattice-aegis on a safety floor (regression + adversarial) plus a tool-use
 * value-proof. ALL DATA IS SYNTHETIC for v1 (no Sonder audit chain yet); every output says so.
 *
 * No default exports (match package style).
 */

// ---- Orchestrator + result types ----
export {
  runBenchmark,
  HONESTY,
  type RunOptions,
  type BenchmarkResult,
  type BenchmarkMetadata,
  type SafetyResult,
  type HonestyFlags,
} from './run.js';

// ---- Report emitters ----
export { toMarkdown, toJSON } from './report.js';

// ---- Scoring (both axes) ----
export {
  safetyMetrics,
  confusion,
  percentile,
  isIntervene,
  type SafetyMetrics,
  type ScoredCase,
  type ConfusionMatrix,
} from './score/safety.js';

export {
  scoreToolUse,
  scoreConfigToolUse,
  predictionIntervenes,
  type ToolUseResult,
  type ToolUseMetrics,
  type OverTimePoint,
  type CallOutcome,
} from './score/tooluse.js';

// ---- Engines / configs ----
export {
  loadAllRules,
  evalRegex,
  evalRegexDecode,
  evalRegexDecodeAwm,
  REAL_CONFIGS,
  ALL_CONFIGS,
  type ConfigName,
} from './engines/regex.js';

export { decodeCommand, type DecodeResult } from './engines/decode.js';

export {
  PriorStore,
  awmPredict,
  AWM_LABEL,
  type AwmFeatures,
} from './engines/awm-stub.js';

// ---- Generator + corpora ----
export {
  generateEpisodes,
  safetyCorpus,
  type Episode,
  type EpisodeCall,
  type SafetyCorpus,
} from './generate.js';

export {
  FAILURE_MODES,
  FAILURE_PROFILES,
  type FailureMode,
  type FailureProfile,
} from './corpus/taxonomy.js';

export {
  REGRESSION_CASES,
  type RegressionCase,
  type ExpectedVerdict,
} from './corpus/regression.js';

export {
  ADVERSARIAL_CASES,
  type AdversarialCase,
  type AdversarialFamily,
} from './corpus/adversarial.js';

// ---- PRNG (exposed so downstream can reproduce seeded draws) ----
export { mulberry32, type Rng } from './prng.js';

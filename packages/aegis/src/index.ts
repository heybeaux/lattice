/**
 * @heybeaux/lattice-aegis — predictive governance harness.
 *
 * Ports AutoHarness's risk corpus into a versioned rule-pack engine, enforces it
 * through Sonder's signed veto, and lets AWM score P(failure) to escalate the gate.
 *
 * @packageDocumentation
 */

export type {
  Severity,
  GateAction,
  RuleCategory,
  MatchTarget,
  MatchKind,
  AllowedFlag,
  RuleMatch,
  Rule,
  RulePack,
  CompiledRule,
  ToolCall,
  RuleHit,
  Prediction,
  Evaluation,
  SeverityTable,
  PredictionThresholds,
} from './types.js';

export { loadPack, RulePackError } from './rules/loader.js';
export { mergeLayers } from './rules/merge.js';
export type { MergeResult, MergeWarning } from './rules/merge.js';

export { isSafeCommand, DEFAULT_SAFE } from './eval/safe-command.js';
export {
  evaluate,
  DEFAULT_SEVERITY_TABLE,
  DEFAULT_PREDICTION_THRESHOLDS,
} from './eval/evaluate.js';
export type { EvaluateOptions } from './eval/evaluate.js';
export { extractDecodedVariants } from './eval/preprocess.js';

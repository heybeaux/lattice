/**
 * The evaluator: match rules, take the deterministic severity floor, optionally
 * escalate with an AWM prediction, return the strictest action.
 *
 * Combination rule (the heart of Aegis):
 *   action = strictest_of(severity_floor, prediction_overlay)
 *   order: deny > ask > allow
 * The predictor can only ESCALATE — it can never turn a critical match into allow.
 * See docs/aegis-rulepack-spec-2026-06-14.md §4.
 */

import type {
  CompiledRule,
  Evaluation,
  GateAction,
  Prediction,
  PredictionThresholds,
  RuleHit,
  Severity,
  SeverityTable,
  ToolCall,
} from '../types.js';

export const DEFAULT_SEVERITY_TABLE: SeverityTable = {
  critical: 'deny',
  high: 'ask',
  medium: 'ask',
  low: 'allow',
};

export const DEFAULT_PREDICTION_THRESHOLDS: PredictionThresholds = {
  denyAtOrAbove: 0.8,
  askAtOrAbove: 0.4,
};

const ACTION_RANK: Record<GateAction, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function strictest(a: GateAction, b: GateAction): GateAction {
  return ACTION_RANK[a] >= ACTION_RANK[b] ? a : b;
}

function targetString(call: ToolCall, target: CompiledRule['rule']['match']['target']): string[] {
  switch (target) {
    case 'command':
      return call.command ? [call.command] : [];
    case 'content':
      return call.content ? [call.content] : [];
    case 'path':
      return call.paths ?? [];
    case 'argv':
      return call.argv ?? [];
  }
}

function ruleApplies(appliesTo: string[], tool: string): boolean {
  return appliesTo.includes('*') || appliesTo.includes(tool);
}

function matchesRule(compiled: CompiledRule, call: ToolCall): boolean {
  const { rule, regex } = compiled;
  if (!ruleApplies(rule.appliesTo, call.tool)) return false;
  if (rule.enabled === false) return false;

  const strings = targetString(call, rule.match.target);
  for (const s of strings) {
    if (rule.match.kind === 'regex' && regex) {
      if (regex.test(s)) return true;
    } else if (rule.match.kind === 'substring') {
      if (s.includes(rule.match.pattern)) return true;
    }
  }
  return false;
}

function predictionAction(
  prediction: Prediction | undefined,
  thresholds: PredictionThresholds,
): GateAction {
  if (!prediction) return 'allow';
  if (prediction.pFailure >= thresholds.denyAtOrAbove) return 'deny';
  if (prediction.pFailure >= thresholds.askAtOrAbove) return 'ask';
  return 'allow';
}

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface EvaluateOptions {
  severityTable?: SeverityTable;
  predictionThresholds?: PredictionThresholds;
  prediction?: Prediction;
  ruleVersions?: string[];
}

export function evaluate(
  call: ToolCall,
  compiledRules: CompiledRule[],
  opts: EvaluateOptions = {},
): Evaluation {
  const severityTable = opts.severityTable ?? DEFAULT_SEVERITY_TABLE;
  const thresholds = opts.predictionThresholds ?? DEFAULT_PREDICTION_THRESHOLDS;

  const hits: RuleHit[] = [];
  let maxSeverity: Severity | null = null;
  let topReason = '';

  for (const compiled of compiledRules) {
    if (!matchesRule(compiled, call)) continue;
    const { rule } = compiled;
    hits.push({
      id: rule.id,
      severity: rule.severity,
      category: rule.category,
      target: rule.match.target,
    });
    if (maxSeverity === null || SEVERITY_RANK[rule.severity] > SEVERITY_RANK[maxSeverity]) {
      maxSeverity = rule.severity;
      topReason = rule.description;
    }
  }

  const severityFloor: GateAction = maxSeverity ? severityTable[maxSeverity] : 'allow';
  const predAction = predictionAction(opts.prediction, thresholds);
  const action = strictest(severityFloor, predAction);

  let decidedBy: Evaluation['decidedBy'];
  if (severityFloor === action && predAction === action) decidedBy = 'both';
  else if (predAction === action && severityFloor !== action) decidedBy = 'prediction';
  else decidedBy = 'severity';

  const reason =
    decidedBy === 'prediction' && opts.prediction
      ? `predicted P(failure)=${opts.prediction.pFailure.toFixed(2)} — ${action}`
      : topReason || 'no rule matched';

  return {
    action,
    decidedBy,
    matches: hits,
    prediction: opts.prediction,
    reason,
    ruleVersions: opts.ruleVersions ?? [],
  };
}

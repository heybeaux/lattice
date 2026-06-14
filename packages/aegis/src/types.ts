/**
 * Aegis core types.
 *
 * Rule packs are DATA (JSON), the engine is the only code. These types are the
 * contract for both. See docs/aegis-rulepack-spec-2026-06-14.md.
 *
 * Note on severity vs RiskLevel: Aegis rule `Severity` is a superset of Lattice's
 * contract-level `RiskLevel` ('low'|'medium'|'high') — it adds 'critical'. Severity is
 * internal to rule classification and maps into a gate action; it is NOT the contract type.
 */

/** Rule severity — internal to Aegis rule packs (superset of Lattice RiskLevel). */
export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** What the gate ultimately returns to the Sonder hook. */
export type GateAction = 'allow' | 'ask' | 'deny';

/** Rule classification buckets. */
export type RuleCategory =
  | 'bash'
  | 'file_write'
  | 'file_read'
  | 'secrets'
  | 'injection'
  | 'pii';

/** Which assembled string a rule tests. */
export type MatchTarget = 'command' | 'content' | 'path' | 'argv';

/** How a rule matches. `ast` is reserved for Phase 5 (code-tool parsing). */
export type MatchKind = 'regex' | 'substring' | 'ast';

/** Subset of JS RegExp flags Aegis allows. No `g` (stateful lastIndex is a footgun). */
export type AllowedFlag = 'i' | 'm' | 's' | 'u';

export interface RuleMatch {
  kind: MatchKind;
  /** Raw pattern source. For `regex`, a JS-dialect RegExp source string. */
  pattern: string;
  /** Allowed flags only; validated at load. */
  flags?: string;
  target: MatchTarget;
}

export interface Rule {
  /** Stable, namespaced, kebab id — THE merge/override key (e.g. "bash.rm-rf-root"). */
  id: string;
  category: RuleCategory;
  severity: Severity;
  description: string;
  match: RuleMatch;
  /** Tool-name allowlist (Claude Code / OpenClaw names). ["*"] = any tool. */
  appliesTo: string[];
  remediation?: string;
  references?: string[];
  /** Packs may ship disabled rules; overlays can flip. Defaults true. */
  enabled?: boolean;
  /** Required on an overlay rule that LOWERS a builtin's strictness. Default false. */
  allowDowngrade?: boolean;
}

export interface RulePack {
  packId: string;
  version: string;
  source?: string;
  engineMin?: string;
  rules: Rule[];
}

/** A rule compiled and ready for matching. */
export interface CompiledRule {
  rule: Rule;
  /** Present when match.kind === 'regex'. */
  regex?: RegExp;
}

/** Inputs the evaluator tests rules against. Assembled by the host/hook. */
export interface ToolCall {
  /** Claude Code / OpenClaw tool name, e.g. "Bash", "Write", "Edit", "Read". */
  tool: string;
  /** Assembled shell command, for bash-like tools. */
  command?: string;
  /** File/secret content, for write/secret rules. */
  content?: string;
  /** Paths touched by the call. */
  paths?: string[];
  /** Raw argv, for argv-target rules. */
  argv?: string[];
}

/** One rule that fired during evaluation. */
export interface RuleHit {
  id: string;
  severity: Severity;
  category: RuleCategory;
  target: MatchTarget;
}

/** A predictive contribution (AWM or rule-derived prior). */
export interface Prediction {
  pFailure: number;
  confidence: number;
  source: 'awm' | 'prior';
}

/** The evaluator's output — exactly what the Sonder hook consumes and emits. */
export interface Evaluation {
  action: GateAction;
  decidedBy: 'severity' | 'prediction' | 'both';
  matches: RuleHit[];
  prediction?: Prediction;
  reason: string;
  ruleVersions: string[];
}

/** severity -> deterministic floor action (the constitution table). */
export type SeverityTable = Record<Severity, GateAction>;

export interface PredictionThresholds {
  /** P(failure) >= this -> deny. */
  denyAtOrAbove: number;
  /** P(failure) >= this -> ask. */
  askAtOrAbove: number;
}

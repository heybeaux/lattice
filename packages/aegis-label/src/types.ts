/**
 * Aegis labeling pipeline — core types.
 *
 * This package consumes the Sonder audit chain to produce a leak-free
 * `action_failed` dataset (label-spec §1, §5). It deliberately does NOT take a
 * runtime dependency on Sonder: instead it defines a minimal `SonderEventLike`
 * envelope (the fields it actually reads) and an `AuditLogReader` port. The real
 * Sonder `AuditLog` satisfies the port structurally; tests use in-memory
 * fixtures. See scope-doc §1 and label-spec §1.5.
 */

import type { Severity, Prediction } from '@heybeaux/lattice-aegis';

export type { Severity, Prediction };

/** Schema version stamped on every dataset row (honesty requirement, scope §7). */
export const SCHEMA_VERSION = 1 as const;

/** Whether a row came from a live chain or a synthetic generator (scope §7). */
export type DataSource = 'real' | 'synthetic';

/**
 * Which failure signal fired, in label-spec §2 priority order. First match wins.
 */
export type LabelReason =
  | 'human_veto'
  | 'tool_error'
  | 'downstream_error'
  | 'rollback';

/** Writes-vs-reads classification of the gated action's resource access. */
export type WritesVsReads = 'read' | 'write' | 'mixed' | 'none';

/** Session-level regime analog (label-spec §6). */
export type SessionHealthRegime = 'clean' | 'recovering' | 'thrashing';

/**
 * Structured post-execution outcome — mirror of Sonder `OutcomeContext`
 * (`event.ts:117-124`). Absent on pre-execution decision events.
 */
export interface OutcomeLike {
  /** Process/tool exit code. 0 = clean; non-zero = error (label signal #2). */
  exit_code?: number;
  /** True when the tool reported an error result regardless of exit code. */
  isError: boolean;
  /** Structured error message/string when the action failed. */
  error?: string;
}

/**
 * The Aegis gate decision attached to a decision event, surfaced through
 * `governance.approval_gate`. We model only the bits the pipeline reads.
 */
export interface ApprovalGateLike {
  state: 'pending' | 'allowed' | 'denied';
  gate_id: string;
  reason?: string;
  default_action: 'deny' | 'allow';
  expires_at?: string;
}

/**
 * Per-rule evidence row carried on the decision event's `governance.evidence`.
 * Mirror of Sonder `PolicyEvidenceRow` (`event.ts:34-41`).
 */
export interface PolicyEvidenceRowLike {
  rule_id: string;
  rule_kind: string;
  path?: string;
  outcome: 'pass' | 'deny' | 'mask';
  matched?: string;
  message?: string;
}

/**
 * Governance block we consume from a decision event — subset of Sonder
 * `GovernanceContext` (`event.ts:60-83`).
 */
export interface GovernanceLike {
  approval_gate?: ApprovalGateLike;
  evidence?: PolicyEvidenceRowLike[];
}

/**
 * The Aegis rule-eval output attached to a decision event, used as the source of
 * truth for command-shape features (scope §[D]: "no re-parsing"). The Aegis hook
 * stamps this onto the decision event's `metadata` when it emits.
 */
export interface AegisDecisionMeta {
  /** The tool the gated call invoked (e.g. "Bash", "Write"). */
  tool: string;
  /** Highest severity rule that matched; 'none' when nothing fired. */
  ruleSeverityMax: Severity | 'none';
  /** Distinct rule categories that fired (multi-hot source). */
  ruleCategoriesHit: string[];
  /** Rule ids that fired (high-cardinality embedding source). */
  ruleIdsHit: string[];
  /** Assembled command length in characters. */
  cmdLength: number;
  /** Count of shell combinators (; && || | $() ` > <). */
  combinatorCount: number;
  /** Number of distinct paths the action touches. */
  pathsTouched: number;
  /** Read/write classification of the action. */
  writesVsReads: WritesVsReads;
  /** Whether the action touches a git resource. */
  touchesGit: boolean;
  /** Whether the action touches a system directory. */
  touchesSystemDir: boolean;
  /** Whether the action creates a new file. */
  newFile: boolean;
  /** Rule-category bucket for window override selection (scope §[B]). */
  windowCategory?: string;
}

/**
 * Minimal Sonder event envelope — exactly the fields this package reads. The
 * real `SonderEventV2`/`SonderEventV1` satisfy this structurally. We avoid the
 * full Sonder type to keep aegis-label decoupled and fixture-testable.
 * See `event.ts:131-167`.
 */
export interface SonderEventLike {
  id: string;
  agent_id: string;
  task_id: string;
  parent_id?: string;
  /** ISO 8601. */
  timestamp: string;
  governance: GovernanceLike;
  /** Present on post-execution outcome events; absent on decision events. */
  outcome?: OutcomeLike;
  /** Affected resources (files, tables, URLs). Rollback-overlap source. */
  resources?: string[];
  /** Filesystem paths touched. Narrower alias of `resources`. */
  paths?: string[];
  payload: unknown;
  /**
   * Free-form metadata. The Aegis hook stamps `aegis` (rule-eval output) and may
   * stamp `kind` (event kind tag) here.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Read-only port over the Sonder audit chain (scope §1: "Sonder is read-only
 * here"). The real `AuditLog` satisfies these methods (`audit.ts`); tests supply
 * an in-memory fixture reader. Keeping this a port — and NOT a hard Sonder dep —
 * is what keeps the pipeline decoupled and fixture-testable. The pipeline takes
 * a `ChainReader` by injection (constructor/function arg), never imports Sonder.
 */
export interface ChainReader {
  /** Fetch a single event by id (null when absent). */
  getEvent(id: string): SonderEventLike | null;
  /** Direct children of `parent_id` (`audit.ts` queryChildren). */
  queryChildren(parent_id: string): SonderEventLike[];
  /**
   * BFS over the causal DAG rooted at `rootId`. Root is NOT included.
   * Cycle-safe, timestamp-ordered. `opts.maxDepth` caps depth (`audit.ts:261`).
   */
  queryDescendants(
    rootId: string,
    opts?: { maxDepth?: number },
  ): SonderEventLike[];
}

/**
 * @deprecated Use {@link ChainReader}. Retained as a structural alias: any
 * `ChainReader` is a valid `AuditLogReader` (the two query methods).
 */
export type AuditLogReader = Pick<
  ChainReader,
  'queryChildren' | 'queryDescendants'
>;

/** The as-of prior lookup result (label-spec §5 feature names). */
export interface PriorResult {
  /** Historical fail-rate for (tool, path-prefix). */
  histFailRate_toolPath: number;
  /** Seconds since the last failure on this (tool, path); null if none/unknown. */
  secsSinceLastFailHere: number | null;
  /** Sample size behind the prior (for shrinkage). */
  engramPriorN: number;
}

/**
 * As-of prior source (label-spec §5; the Engram edge). Queried as-of
 * `signalDate`, NEVER "now", to prevent today's outcomes leaking into a past
 * row's prior (same bug class as AWM's 2026-04-21 stale-cache fix). Modelled as
 * an injected port; we never call Engram directly (testability, scope §[D]).
 */
export interface PriorSource {
  lookup(query: {
    tool: string;
    pathPrefix: string;
    /** As-of ISO date — the decision's signalDate, not wall-clock now. */
    asOf: string;
  }): PriorResult;
}

/**
 * @deprecated Use {@link PriorSource}. Structural alias kept for the old
 * `histFailRate`-shaped port.
 */
export interface EngramPriorPort {
  histFailRate(query: {
    tool: string;
    pathPrefix: string;
    asOf: string;
  }): { rate: number; n: number; secsSinceLastFail: number | null };
}

/**
 * The feature row, assembled at decision time and frozen (label-spec §5).
 * Every field is known at/before the decision event's timestamp.
 */
export interface FeatureRow {
  // identity / target keys
  decisionEventId: string;
  signalDate: string;

  // command-shape (from the decision event's attached rule-eval output)
  tool: string;
  ruleSeverityMax: Severity | 'none';
  ruleCategoriesHit: string[];
  ruleIdsHit: string[];
  cmdLength: number;
  combinatorCount: number;
  pathsTouched: number;
  writesVsReads: WritesVsReads;
  touchesGit: boolean;
  touchesSystemDir: boolean;
  newFile: boolean;

  // context
  agentId: string;
  taskDepth: number;
  priorFailuresThisSession: number;
  sessionHealthRegime: SessionHealthRegime;

  /**
   * Walk-backward rollback signal (leak-safe): a rollback action (git
   * revert/reset/restore, trash-restore, or a `kind:'rollback'` event) hit a
   * path overlapping this decision's target within the last `rollbackProximityN`
   * in-session events at/before the decision. 0 when there is no such churn.
   *
   * WHY: a clean command can still be doomed when it edits a path the session
   * just reverted — the reactive rules see nothing (zero rule hits, benign
   * shape), but the chain shows the path is in an active churn/rollback zone.
   * This is the only feature that gives the predictor that signal, and it is
   * strictly backward-looking so it never leaks the post-decision outcome.
   */
  rollbackProximity: number;

  // Engram priors (queried as-of signalDate)
  histFailRate_toolPath: number;
  secsSinceLastFailHere: number | null;
  engramPriorN: number;
}

/**
 * A minted, not-yet-resolved row in the open-window store (scope §[A]).
 * Holds the frozen feature row plus the metadata the window/resolver need.
 */
export interface PendingRow {
  decisionEventId: string;
  signalDate: string;
  /** ISO timestamp of the decision event — the leak boundary. */
  decisionTimestamp: string;
  /** Wall-clock window-close deadline (ISO), computed by the window manager. */
  windowDeadline: string;
  /** Rule-category bucket driving per-category window overrides. */
  windowCategory?: string;
  features: FeatureRow;
  dataSource: DataSource;
}

/**
 * A frozen, resolved training example (label-spec §5). `action_failed` may be
 * `null` (excluded from training) when the outcome is unknowable — Truth-above-
 * all: a missing label beats a fabricated one (label-spec §2).
 */
export interface FrozenRow {
  features: FeatureRow;
  /** 1 = failed, 0 = success, null = excluded (unknowable). */
  action_failed: 0 | 1 | null;
  labelReason: LabelReason | null;
  labelConfidence: number | null;
  decisionEventId: string;
  signalDate: string;
  dataSource: DataSource;
  schemaVersion: number;
}

/**
 * Alias for {@link FrozenRow}. "Frozen" describes window state (the row is
 * eligible for bake); "labeled" describes the same row by its content (it now
 * carries `action_failed`). They are the same artifact (scope §[E]).
 */
export type LabeledRow = FrozenRow;

/** Outcome of resolving a label over a closed window (scope §[C]). */
export interface LabelResult {
  action_failed: 0 | 1 | null;
  labelReason: LabelReason | null;
  labelConfidence: number | null;
}

/** Window configuration (scope §[B], label-spec §8.5). */
export interface WindowConfig {
  /** Default wall-clock cap in milliseconds (10 min). */
  defaultMs: number;
  /** Per-category overrides keyed by rule category (e.g. bash/secrets → 30 min). */
  byCategory: Record<string, number>;
}

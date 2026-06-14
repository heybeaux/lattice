import type { StateContract } from '../contract/types.js';

/**
 * Validation tier levels for the Circuit Breaker.
 *
 * - L0: Deterministic policy rules (JSONPath predicates) — runs before L1 when a
 *   `PolicyRuleSet` is bound. Hard-no on any rule failure.
 * - L1: Structural (JSON Schema) — deterministic, zero LLM calls
 * - L2: Semantic consistency (embedding similarity) — requires user-injected EmbeddingProvider
 * - L3: LLM-as-judge — requires user-injected JudgeProvider
 */
export type ValidationTier = 'L0' | 'L1' | 'L2' | 'L3';

/**
 * Discriminator for the eight L0 rule kinds supported by Lattice's policy tier.
 */
export type PolicyRuleKind =
  | 'allowlist'
  | 'denylist'
  | 'regex-deny'
  | 'numeric-bound'
  | 'required'
  | 'forbidden'
  | 'conditional'
  | 'custom';

/**
 * Predicate vocabulary for the `conditional` rule kind's `when` / `then` clauses.
 */
export type ConditionalPredicate =
  | { jsonpath: string; predicate: 'resolves' }
  | { jsonpath: string; predicate: 'is-truthy' }
  | { jsonpath: string; predicate: 'matches'; value: string };

/**
 * Fields shared by every L0 policy rule, independent of kind. Internal — not exported
 * from the package root; consumers should use the {@link PolicyRule} union.
 */
interface PolicyRuleBase {
  /** Stable identifier across versions. Used for evidence rows and audit. */
  id: string;
  /** Human-readable, one-line. Surfaces in reject reasons. */
  description: string;
  /** JSONPath into the StateContract being evaluated. Must start with `$`. */
  jsonpath: string;
}

/**
 * A single L0 policy rule. Discriminated union over {@link PolicyRuleKind}.
 *
 * For `conditional` rules, `PolicyRuleBase.jsonpath` MUST equal `when.jsonpath` so
 * evidence rows surface the path that triggered evaluation. This invariant is
 * enforced at `PolicyRuleSet` construction time (Task 3), not at the type level.
 */
export type PolicyRule =
  | (PolicyRuleBase & { kind: 'allowlist'; values: readonly string[] })
  | (PolicyRuleBase & { kind: 'denylist'; values: readonly string[] })
  | (PolicyRuleBase & { kind: 'regex-deny'; pattern: string; flags?: string })
  | (PolicyRuleBase & {
      kind: 'numeric-bound';
      op: '<=' | '<' | '>=' | '>' | '==';
      value: number;
    })
  | (PolicyRuleBase & { kind: 'required' })
  | (PolicyRuleBase & { kind: 'forbidden' })
  | (PolicyRuleBase & {
      kind: 'conditional';
      /** Antecedent. When this predicate is satisfied, `then` MUST be satisfied. */
      when: ConditionalPredicate;
      /** Consequent. Required only when `when` is satisfied. */
      then: ConditionalPredicate;
    })
  | (PolicyRuleBase & {
      kind: 'custom';
      /**
       * Pure, deterministic, sync. Receives the canonicalized contract.
       * Prefer `conditional` for cross-field invariants.
       */
      evaluate: (contract: StateContract) => boolean;
    });

/**
 * A versioned bundle of L0 policy rules. Bound to the breaker via
 * `TieredCircuitBreakerConfig.policy`.
 */
export interface PolicyRuleSet {
  /** Stable identifier; appears on every evidence row. */
  id: string;
  /** Opaque version string. Bumped by hand on rule changes. */
  version: string;
  rules: readonly PolicyRule[];
}

/**
 * Per-rule result record produced by L0 evaluation and attached to
 * `contract.metadata.l0.evidence`.
 */
export interface PolicyEvidenceRow {
  ruleId: string;
  kind: PolicyRuleKind;
  outcome: 'pass' | 'fail' | 'skip';
  jsonpath: string;
  /** Present when outcome = 'fail'. One sentence, no payload values. */
  detail?: string;
}

/**
 * Configuration for the tiered Circuit Breaker.
 */
export interface TieredCircuitBreakerConfig {
  /**
   * Validation mode.
   *
   * 'auto' (default): L1 runs on every handoff. L2 runs if an EmbeddingProvider
   * is configured. L3 only runs if L2 similarity falls below l3EscalationThreshold
   * OR the contract is marked as high-risk via metadata.isHighRisk.
   *
   * Explicit modes run the specified tiers on every handoff:
   * - 'L1' — structural validation only
   * - 'L1+L2' — structural + embedding similarity
   * - 'L1+L3' — structural + LLM-as-judge
   * - 'L1+L2+L3' — all tiers on every handoff (slowest, most thorough)
   *
   * When {@link policy} is set, L0 runs before whatever value is selected here.
   */
  tier?: 'auto' | 'L1' | 'L1+L2' | 'L1+L3' | 'L1+L2+L3';

  /**
   * Optional L0 deterministic policy rule set. When set, L0 runs before L1/L2/L3
   * and a rule failure is a hard-no (skips later tiers). Defaults to undefined,
   * in which case L0 is a no-op and v0.3 ordering applies.
   */
  policy?: PolicyRuleSet;

  /** Embedding similarity threshold for L2 pass/fail (default: 0.7) */
  l2Threshold?: number;

  /**
   * L2 similarity threshold below which L3 is triggered (auto mode only).
   * If L2 similarity falls below this value, L3 LLM-as-judge runs as escalation.
   * Default: 0.85
   */
  l3EscalationThreshold?: number;

  /** LLM-as-judge confidence threshold for L3 pass/fail (default: 0.7) */
  l3ConfidenceThreshold?: number;

  /** Consecutive failures before opening the circuit (default: 3) */
  failureThreshold?: number;

  /** Recovery timeout before half-open in ms (default: 60000) */
  recoveryTimeoutMs?: number;

  /** Behavior on validation failure (default: 'abort') */
  onReject?: 'abort' | 'retry' | 'fallback' | 'degrade';

  /** Max retries when onReject is 'retry' (default: 2) */
  maxRetries?: number;

  /**
   * Redaction policy for payloads sent to external L2/L3 providers
   * (issue #6 / SEC-004). Validation tiers serialize payload bodies and
   * ship them to OpenAI's embedding/chat APIs — without redaction, raw
   * secrets in `contract.inputs.payload`, `contract.outputs.payload`,
   * decisions, constraints, and assumptions leave the trust boundary
   * verbatim.
   *
   * Modes:
   *  - 'redact' (DEFAULT): redact the contract via the same key-name +
   *    pattern detectors used by `redactContract` before canonicalization,
   *    so raw secrets never reach a remote provider.
   *  - 'raw': ship payloads unredacted. Caller has explicitly accepted
   *    that secrets in payloads will be transmitted to the configured
   *    L2/L3 provider — only safe with self-hosted / on-prem providers.
   *
   * The redaction is applied ONLY to data leaving the process via L2/L3
   * providers. The original contract returned to callers and emitted on
   * the event bus is unchanged.
   */
  providerRedaction?: 'redact' | 'raw';

  /**
   * Sensitivity level used when {@link providerRedaction} is `'redact'`.
   * Defaults to 'high' to maximize coverage on the secret-exfiltration
   * boundary; downgrade to 'medium' or 'low' only when payload bodies
   * legitimately need to retain phone/email/PII for the judge to evaluate.
   */
  providerRedactionLevel?: 'low' | 'medium' | 'high';
}

/**
 * Result from a validation attempt.
 */
export interface ValidationResult {
  /** Whether the contract passed validation */
  passed: boolean;
  /**
   * Tier at which the final pass/fail was determined. For passing
   * validations this is the last tier that actually ran. For failing
   * validations this is the tier that produced the failure.
   */
  tier: ValidationTier;
  /**
   * Ordered list of tiers that actually ran during this validate() call.
   * Skipped tiers (e.g. L1/L2/L3 after an L0 fail; L2/L3 when no
   * provider is configured) do NOT appear. Adapters use this to compute
   * the `+`-joined `governance.tier` field (Spec 1 R8).
   *
   * Optional for back-compat — when the breaker has no L0 policy bound,
   * existing call sites can continue to inspect just `tier`.
   */
  tiersRun?: ValidationTier[];
  /** Duration in milliseconds */
  durationMs: number;
  /** Failure reason (if failed) */
  reason?: string;
  /** Confidence score (L2 similarity or L3 judge confidence) */
  confidence?: number;
  /**
   * Set to `true` when the result was synthesised by the graceful-degradation
   * path (i.e. a provider threw a known provider error and `onReject` is
   * `'degrade'`). Callers can inspect this flag to decide whether to apply
   * extra caution despite `passed === true`.
   */
  providerFailure?: boolean;
  /** Optional metadata bag for attaching extra context to the result. */
  metadata?: Record<string, unknown>;
}

/**
 * Provider interface for L2 embedding similarity checks.
 * User must inject an implementation — Lattice ships none by default.
 *
 * Performance contract (issue #19):
 * - When `embedBatch` is implemented, the breaker batches the two L2
 *   embedding calls (expected + actual) into a single provider request.
 *   This halves round-trips and is the recommended path for any provider
 *   whose backend supports array inputs (e.g., OpenAI's embeddings API).
 * - When `embedBatch` is absent, the breaker falls back to two parallel
 *   `embed` calls — preserving the original semantics for older providers.
 */
export interface EmbeddingProvider {
  /** Get embedding vector for a single string. */
  embed(text: string): Promise<number[]>;
  /**
   * Optional: get embedding vectors for multiple strings in a SINGLE
   * provider request. Implementations MUST return one vector per input
   * in the same order. The breaker prefers this entrypoint when present
   * to avoid the 2x round-trip + cost on every L2 step (issue #19).
   */
  embedBatch?(texts: string[]): Promise<number[][]>;
  /** Compute cosine similarity between two vectors. */
  similarity(a: number[], b: number[]): number;
}

/**
 * Result from an LLM-as-judge evaluation.
 */
export interface JudgeResult {
  /** pass, fail, or uncertain */
  verdict: 'pass' | 'fail' | 'uncertain';
  /** Confidence score 0-1 */
  confidence: number;
  /** Reasoning from the judge */
  reasoning?: string;
}

/**
 * Provider interface for L3 LLM-as-judge validation.
 * User must inject an implementation — Lattice ships none by default.
 */
export interface JudgeProvider {
  /** Evaluate whether the output addresses the task */
  judge(
    task: string,
    output: string,
    contractContext: string,
  ): Promise<JudgeResult>;
}

/**
 * Validation tier levels for the Circuit Breaker.
 *
 * - L1: Structural (JSON Schema) — deterministic, zero LLM calls
 * - L2: Semantic consistency (embedding similarity) — requires user-injected EmbeddingProvider
 * - L3: LLM-as-judge — requires user-injected JudgeProvider
 */
export type ValidationTier = 'L1' | 'L2' | 'L3';

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
   */
  tier?: 'auto' | 'L1' | 'L1+L2' | 'L1+L3' | 'L1+L2+L3';

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
  /** Which tier the validation was performed at */
  tier: ValidationTier;
  /** Duration in milliseconds */
  durationMs: number;
  /** Failure reason (if failed) */
  reason?: string;
  /** Confidence score (L2 similarity or L3 judge confidence) */
  confidence?: number;
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

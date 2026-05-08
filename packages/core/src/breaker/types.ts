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
   * Which validation tiers to enable.
   * - 'L1' — structural validation only (default, zero deps)
   * - 'L1+L2' — structural + embedding similarity
   * - 'L1+L3' — structural + LLM-as-judge
   * - 'L1+L2+L3' — all tiers enabled
   */
  tier?: 'L1' | 'L1+L2' | 'L1+L3' | 'L1+L2+L3';

  /** Embedding similarity threshold for L2 (default: 0.7) */
  l2Threshold?: number;

  /** LLM-as-judge confidence threshold for L3 (default: 0.7) */
  l3ConfidenceThreshold?: number;

  /** Consecutive failures before opening the circuit (default: 3) */
  failureThreshold?: number;

  /** Recovery timeout before half-open in ms (default: 60000) */
  recoveryTimeoutMs?: number;

  /** Behavior on validation failure (default: 'abort') */
  onReject?: 'abort' | 'retry' | 'fallback' | 'degrade';

  /** Max retries when onReject is 'retry' (default: 2) */
  maxRetries?: number;
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
  /** Confidence score (L3 only) */
  confidence?: number;
}

/**
 * Provider interface for L2 embedding similarity checks.
 * User must inject an implementation — Lattice ships none by default.
 */
export interface EmbeddingProvider {
  /** Get embedding vector for a string */
  embed(text: string): Promise<number[]>;
  /** Compute cosine similarity between two vectors */
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

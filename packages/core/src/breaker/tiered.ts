import { SchemaValidator, ValidationResult as SchemaResult } from '../contract/validator.js';
import { StateContract } from '../contract/types.js';
import { CircuitBreaker } from './breaker.js';
import {
  TieredCircuitBreakerConfig,
  ValidationResult,
  ValidationTier,
  EmbeddingProvider,
  JudgeProvider,
} from './types.js';

/**
 * Tiered Circuit Breaker that validates State Contracts through
 * multiple levels of scrutiny.
 *
 * Default mode (auto): L1 runs on every handoff. L2 runs if an EmbeddingProvider
 * is configured. L3 only runs if L2 similarity falls below the escalation
 * threshold OR the contract is marked as high-risk via metadata.
 *
 * Manual mode: Use the explicit tier config ('L1', 'L1+L2', etc.) for full
 * control over which tiers run.
 *
 * Validation tiers:
 * - L1: Structural (JSON Schema) — deterministic, zero LLM calls, <200ms
 * - L2: Semantic consistency (embedding similarity) — requires EmbeddingProvider
 * - L3: LLM-as-judge — requires JudgeProvider, 1-3s (only on escalation)
 */
export class TieredCircuitBreaker {
  private readonly config: Required<
    Pick<
      TieredCircuitBreakerConfig,
      | 'tier'
      | 'l2Threshold'
      | 'l3ConfidenceThreshold'
      | 'failureThreshold'
      | 'recoveryTimeoutMs'
      | 'onReject'
      | 'maxRetries'
    >
  > & {
    /** L2 similarity threshold below which L3 is triggered (auto mode) */
    l3EscalationThreshold: number;
  };

  private readonly schemaValidator: SchemaValidator;
  private readonly breaker: CircuitBreaker;
  private embeddingProvider?: EmbeddingProvider;
  private judgeProvider?: JudgeProvider;

  constructor(config?: TieredCircuitBreakerConfig) {
    this.config = {
      tier: config?.tier ?? 'auto',
      l2Threshold: config?.l2Threshold ?? 0.7,
      l3ConfidenceThreshold: config?.l3ConfidenceThreshold ?? 0.7,
      l3EscalationThreshold: config?.l3EscalationThreshold ?? 0.85,
      failureThreshold: config?.failureThreshold ?? 3,
      recoveryTimeoutMs: config?.recoveryTimeoutMs ?? 60_000,
      onReject: config?.onReject ?? 'abort',
      maxRetries: config?.maxRetries ?? 2,
    };

    this.schemaValidator = new SchemaValidator();
    this.breaker = new CircuitBreaker({
      failureThreshold: this.config.failureThreshold,
      recoveryTimeoutMs: this.config.recoveryTimeoutMs,
    });
  }

  /**
   * Set the embedding provider for L2 validation.
   * Must be called before L2 validation will work.
   */
  setEmbeddingProvider(provider: EmbeddingProvider): this {
    this.embeddingProvider = provider;
    return this;
  }

  /**
   * Set the judge provider for L3 validation.
   * Must be called before L3 validation will work.
   */
  setJudgeProvider(provider: JudgeProvider): this {
    this.judgeProvider = provider;
    return this;
  }

  /** Current circuit breaker state */
  get state() {
    return this.breaker.state;
  }

  /** Current circuit breaker metrics */
  get metrics() {
    return this.breaker.metrics;
  }

  /** Whether the circuit allows validation attempts */
  canAttempt() {
    return this.breaker.canAttempt();
  }

  /** Reset the circuit breaker */
  reset() {
    this.breaker.reset();
  }

  /**
   * Validate a State Contract through the configured tiers.
   *
   * In auto mode (default):
   * 1. L1 always runs (structural validation)
   * 2. L2 runs if EmbeddingProvider is configured
   * 3. L3 runs only if L2 similarity < l3EscalationThreshold OR
   *    contract.metadata.isHighRisk === true
   *
   * In manual mode (explicit tier config):
   * Runs the specified tiers in sequence, stopping at first failure.
   *
   * @param contract - The State Contract to validate
   * @returns ValidationResult with tier, duration, and pass/fail
   */
  async validate(contract: StateContract): Promise<ValidationResult> {
    if (!this.breaker.canAttempt()) {
      return {
        passed: false,
        tier: 'L1',
        durationMs: 0,
        reason: 'Circuit breaker is open',
      };
    }

    const isAuto = this.config.tier === 'auto';

    if (isAuto) {
      return this.validateAuto(contract);
    }

    return this.validateManual(contract);
  }

  /**
   * Auto mode: L1 always, L2 if available, L3 only on escalation.
   * Default latency: <200ms (L1+L2), 1-3s only when L3 escalates.
   */
  private async validateAuto(contract: StateContract): Promise<ValidationResult> {
    const start = Date.now();
    let lastResult: ValidationResult | null = null;

    // L1: Always run
    const l1 = this.validateL1(contract, start);
    lastResult = l1;
    if (!l1.passed) {
      this.breaker.recordFailure();
      return l1;
    }

    // L2: Run if provider is available
    let l2Similarity: number | null = null;
    if (this.embeddingProvider) {
      const l2 = await this.validateL2(contract, Date.now());
      lastResult = l2;
      if (!l2.passed) {
        this.breaker.recordFailure();
        return l2;
      }
      // Extract similarity for escalation decision
      l2Similarity = l2.confidence ?? null;
    }

    // L3: Only run if L2 similarity is below threshold OR contract is high-risk
    const isHighRisk = (contract.metadata as any)?.isHighRisk === true;
    const needsEscalation = l2Similarity !== null && l2Similarity < this.config.l3EscalationThreshold;

    if ((needsEscalation || isHighRisk) && this.judgeProvider) {
      const l3 = await this.validateL3(contract, Date.now());
      lastResult = l3;
      if (!l3.passed) {
        this.breaker.recordFailure();
        return l3;
      }
    }

    this.breaker.recordSuccess();
    return lastResult!;
  }

  /**
   * Manual mode: Run explicitly configured tiers in sequence.
   */
  private async validateManual(contract: StateContract): Promise<ValidationResult> {
    const enabledTiers = this.getEnabledTiers();
    let lastResult: ValidationResult | null = null;

    for (const tier of enabledTiers) {
      const result = await this.validateTier(contract, tier);
      lastResult = result;
      if (!result.passed) {
        this.breaker.recordFailure();
        return result;
      }
    }

    this.breaker.recordSuccess();
    return lastResult!;
  }

  private getEnabledTiers(): ValidationTier[] {
    switch (this.config.tier) {
      case 'L1':
        return ['L1'];
      case 'L1+L2':
        return ['L1', 'L2'];
      case 'L1+L3':
        return ['L1', 'L3'];
      case 'L1+L2+L3':
        return ['L1', 'L2', 'L3'];
      default:
        return ['L1'];
    }
  }

  private async validateTier(
    contract: StateContract,
    tier: ValidationTier,
  ): Promise<ValidationResult> {
    const start = Date.now();

    switch (tier) {
      case 'L1':
        return this.validateL1(contract, start);
      case 'L2':
        return this.validateL2(contract, start);
      case 'L3':
        return this.validateL3(contract, start);
    }
  }

  private validateL1(
    contract: StateContract,
    start: number,
  ): ValidationResult {
    const result = this.schemaValidator.validate(contract);
    const durationMs = Date.now() - start;

    if (result.valid) {
      return { passed: true, tier: 'L1', durationMs };
    }

    const reasons = result.errors
      .map((e) => `${e.instancePath || 'root'}: ${e.message}`)
      .join('; ');

    return {
      passed: false,
      tier: 'L1',
      durationMs,
      reason: `Schema validation failed: ${reasons}`,
    };
  }

  private async validateL2(
    contract: StateContract,
    start: number,
  ): Promise<ValidationResult> {
    if (!this.embeddingProvider) {
      return {
        passed: false,
        tier: 'L2',
        durationMs: 0,
        reason: 'L2 validation requires an EmbeddingProvider — none configured',
      };
    }

    try {
      const inputText = JSON.stringify(contract.inputs.payload);
      const outputText = JSON.stringify(contract.outputs.payload);

      const [inputVec, outputVec] = await Promise.all([
        this.embeddingProvider.embed(inputText),
        this.embeddingProvider.embed(outputText),
      ]);

      const similarity = this.embeddingProvider.similarity(inputVec, outputVec);
      const durationMs = Date.now() - start;

      if (similarity >= this.config.l2Threshold) {
        return { passed: true, tier: 'L2', durationMs, confidence: similarity };
      }

      return {
        passed: false,
        tier: 'L2',
        durationMs,
        reason: `Semantic similarity ${similarity.toFixed(3)} below threshold ${this.config.l2Threshold}`,
        confidence: similarity,
      };
    } catch (error) {
      return {
        passed: false,
        tier: 'L2',
        durationMs: Date.now() - start,
        reason: `L2 validation error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async validateL3(
    contract: StateContract,
    start: number,
  ): Promise<ValidationResult> {
    if (!this.judgeProvider) {
      return {
        passed: false,
        tier: 'L3',
        durationMs: 0,
        reason: 'L3 validation requires a JudgeProvider — none configured',
      };
    }

    try {
      const task = JSON.stringify(contract.inputs.payload);
      const output = JSON.stringify(contract.outputs.payload);
      const context = JSON.stringify({
        decisions: contract.decisions,
        constraints: contract.constraints,
        assumptions: contract.assumptions,
      });

      const judgeResult = await this.judgeProvider.judge(task, output, context);
      const durationMs = Date.now() - start;

      if (judgeResult.verdict === 'pass') {
        return {
          passed: true,
          tier: 'L3',
          durationMs,
          confidence: judgeResult.confidence,
        };
      }

      if (judgeResult.verdict === 'uncertain' && judgeResult.confidence < this.config.l3ConfidenceThreshold) {
        return {
          passed: false,
          tier: 'L3',
          durationMs,
          reason: `Judge uncertain with confidence ${judgeResult.confidence.toFixed(2)} below threshold ${this.config.l3ConfidenceThreshold}`,
          confidence: judgeResult.confidence,
        };
      }

      return {
        passed: false,
        tier: 'L3',
        durationMs,
        reason: `Judge rejected: ${judgeResult.reasoning ?? 'no reasoning provided'}`,
        confidence: judgeResult.confidence,
      };
    } catch (error) {
      return {
        passed: false,
        tier: 'L3',
        durationMs: Date.now() - start,
        reason: `L3 validation error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

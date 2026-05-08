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
 * Validation tiers:
 * - L1: Structural (JSON Schema) — deterministic, zero LLM calls
 * - L2: Semantic consistency (embedding similarity) — requires EmbeddingProvider
 * - L3: LLM-as-judge — requires JudgeProvider
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
  >;

  private readonly schemaValidator: SchemaValidator;
  private readonly breaker: CircuitBreaker;
  private embeddingProvider?: EmbeddingProvider;
  private judgeProvider?: JudgeProvider;

  constructor(config?: TieredCircuitBreakerConfig) {
    this.config = {
      tier: config?.tier ?? 'L1',
      l2Threshold: config?.l2Threshold ?? 0.7,
      l3ConfidenceThreshold: config?.l3ConfidenceThreshold ?? 0.7,
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
   * Runs L1 → L2 → L3 in sequence, stopping at the first failure.
   * Returns early if the circuit is open.
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
    // Return the last tier's result (preserves confidence, duration, etc.)
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
        return { passed: true, tier: 'L2', durationMs };
      }

      return {
        passed: false,
        tier: 'L2',
        durationMs,
        reason: `Semantic similarity ${similarity.toFixed(3)} below threshold ${this.config.l2Threshold}`,
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

import { createContract } from '../contract/factory.js';
import { StateContract, BudgetRecord } from '../contract/types.js';
import { TieredCircuitBreaker } from '../breaker/tiered.js';
import { TieredCircuitBreakerConfig, ValidationResult } from '../breaker/types.js';

/**
 * Error thrown when a wrapped agent's output fails circuit breaker validation.
 */
export class HandoffFailure extends Error {
  constructor(
    message: string,
    public readonly validation: ValidationResult,
    public readonly contract: StateContract,
  ) {
    super(message);
    this.name = 'HandoffFailure';
  }
}

/**
 * Configuration for a wrapped agent.
 */
export interface WrapAgentConfig<TIn, TOut> {
  /** Unique identifier for this agent */
  id: string;

  /**
   * Circuit breaker configuration.
   *
   * NOTE (issue #23, H14): the breaker config's `onReject: 'retry'` and
   * `maxRetries` options are accepted for backward compatibility but no
   * longer trigger an internal retry loop here. Retry is an orchestration
   * concern and lives at the pipeline level (`PipelineBuilder.onReject`).
   * Stacking a wrapper retry inside a pipeline retry compounded retry
   * counts (up to 9 agent invocations per "configured retry"); see the
   * 2026-05-08 audit, finding H14. When `onReject: 'retry'` is set on the
   * breaker config, this wrapper now behaves identically to `'abort'` —
   * it throws a HandoffFailure and lets the surrounding orchestrator
   * (pipeline, parallel, or your own driver) decide whether to retry.
   */
  breaker?: TieredCircuitBreakerConfig;

  /** Resource budget limits for this agent */
  budget?: {
    maxTokens?: number;
    maxCalls?: number;
    maxWallClockMs?: number;
    maxCost?: number;
  };
}

/**
 * Module-local set tracking which agent ids have already received the
 * deprecation warning so a noisy pipeline doesn't spam stderr on every
 * call. Process-local; reset across processes.
 */
const _retryDeprecationWarned = new Set<string>();

/**
 * A wrapped agent function. Takes input and returns a State Contract.
 */
export type WrappedAgent<TIn, TOut> = (
  input: TIn,
  traceId?: string,
) => Promise<StateContract<TIn, TOut>>;

/**
 * Wrap an agent function with Lattice coordination infrastructure.
 *
 * The wrapped agent:
 * 1. Executes the original agent function
 * 2. Creates a State Contract with the execution results
 * 3. Runs Circuit Breaker validation on the contract
 * 4. Throws HandoffFailure if validation fails (or applies configured recovery)
 *
 * @param agentFn - The original agent function: (input) => Promise<TOut>
 * @param config - Agent configuration (id, breaker, budget)
 * @returns A wrapped function that returns StateContract instead of raw output
 *
 * @example
 * ```ts
 * const researcher = wrapAgent(
 *   async (input: { query: string }) => {
 *     const results = await search(input.query);
 *     return { summary: results.map(r => r.summary).join('\n') };
 *   },
 *   {
 *     id: 'researcher',
 *     breaker: { tier: 'L1+L3' },
 *     budget: { maxTokens: 10000 },
 *   }
 * );
 *
 * const contract = await researcher({ query: 'latest AI papers' });
 * // contract is a StateContract with full lineage
 * ```
 */
export function wrapAgent<TIn = unknown, TOut = unknown>(
  agentFn: (input: TIn) => Promise<TOut> | TOut,
  config: WrapAgentConfig<TIn, TOut>,
): WrappedAgent<TIn, TOut> {
  const breaker = new TieredCircuitBreaker(config.breaker);

  const wrapped: WrappedAgent<TIn, TOut> = async (
    input: TIn,
    traceId?: string,
  ): Promise<StateContract<TIn, TOut>> => {
    const start = Date.now();

    // Execute the agent
    let output: TOut;
    try {
      output = await agentFn(input);
    } catch (error) {
      // Agent threw — create a contract recording the failure
      const budget: BudgetRecord = {
        tokensUsed: 0,
        callsMade: 0,
        wallClockMs: Date.now() - start,
      };

      const contract = createContract<TIn, TOut>({
        fromAgent: config.id,
        traceId,
        inputs: input,
        outputs: null as unknown as TOut,
        constraints: [{
          description: `Agent execution failed: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'error',
        }],
        budget,
      });

      throw new HandoffFailure(
        `Agent "${config.id}" execution failed`,
        { passed: false, tier: 'L1', durationMs: Date.now() - start, reason: 'Agent threw exception' },
        contract,
      );
    }

    const wallClockMs = Date.now() - start;

    // Create the State Contract
    const contract = createContract<TIn, TOut>({
      fromAgent: config.id,
      traceId,
      inputs: input,
      outputs: output,
      budget: {
        tokensUsed: 0, // Agent doesn't report tokens — would need integration
        callsMade: 0,
        wallClockMs,
        limit: config.budget,
      },
    });

    // Run Circuit Breaker validation
    const validation = await breaker.validate(contract);

    if (!validation.passed) {
      const onReject = config.breaker?.onReject ?? 'abort';

      switch (onReject) {
        case 'abort':
          throw new HandoffFailure(
            `Agent "${config.id}" output rejected at ${validation.tier}: ${validation.reason}`,
            validation,
            contract,
          );

        case 'degrade':
          // Continue with flagged contract — add validation status to metadata
          return Object.freeze({
            ...contract,
            metadata: {
              ...contract.metadata,
              validationStatus: 'rejected',
              validationReason: validation.reason,
              validationTier: validation.tier,
            },
          }) as StateContract<TIn, TOut>;

        case 'retry':
          // Issue #23 (H14): the wrapper-level retry loop has been removed
          // to fix retry compounding. When this wrapper sat inside a
          // pipeline that also retried, the two layers multiplied (e.g.
          // wrapper maxRetries=2 × pipeline maxRetries=2 ⇒ 9 agent
          // invocations per "configured retry"). Retry is an orchestration
          // concern and now lives ONLY in the surrounding orchestrator
          // (PipelineBuilder.onReject('retry'), or your own driver).
          //
          // We accept `onReject: 'retry'` on the config for backward
          // compatibility — but it now behaves identically to `'abort'`,
          // letting the surrounding orchestrator decide whether to retry.
          // A one-time per-agent deprecation warning makes the change
          // visible without spamming stderr in a hot loop.
          if (!_retryDeprecationWarned.has(config.id)) {
            _retryDeprecationWarned.add(config.id);
            // eslint-disable-next-line no-console
            console.warn(
              `[lattice] wrapAgent("${config.id}"): breaker.onReject='retry' is deprecated and now behaves like 'abort'. ` +
                `Move retry orchestration to the pipeline layer (PipelineBuilder.onReject('retry', { maxRetries })). ` +
                `See issue #23 / audit finding H14.`,
            );
          }
          throw new HandoffFailure(
            `Agent "${config.id}" output rejected at ${validation.tier}: ${validation.reason}`,
            validation,
            contract,
          );

        case 'fallback':
          // Fallback would require a registered fallback output
          // For v0.1, treat as abort
          throw new HandoffFailure(
            `Agent "${config.id}" output rejected and no fallback registered`,
            validation,
            contract,
          );
      }
    }

    return contract;
  };

  return wrapped;
}

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

  /** Circuit breaker configuration */
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
          // Re-execute with enriched context (max N retries)
          const maxRetries = config.breaker?.maxRetries ?? 2;
          for (let i = 0; i < maxRetries; i++) {
            try {
              const retryOutput = await agentFn(input);
              const retryContract = createContract<TIn, TOut>({
                fromAgent: config.id,
                traceId: contract.traceId,
                inputs: input,
                outputs: retryOutput,
                budget: {
                  tokensUsed: 0,
                  callsMade: 0,
                  wallClockMs: Date.now() - start,
                  limit: config.budget,
                },
              });

              const retryValidation = await breaker.validate(retryContract);
              if (retryValidation.passed) {
                return retryContract;
              }
            } catch {
              // Agent threw again — continue to next retry
            }
          }
          // All retries exhausted — abort
          throw new HandoffFailure(
            `Agent "${config.id}" failed after ${maxRetries} retries`,
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

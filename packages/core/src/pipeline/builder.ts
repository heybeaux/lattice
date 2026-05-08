import { StateContract } from '../contract/types.js';
import { TieredCircuitBreaker, wrapAgent } from '../index.js';
import { TieredCircuitBreakerConfig } from '../breaker/types.js';
import { WrappedAgent, WrapAgentConfig, HandoffFailure } from '../wrapper/wrap-agent.js';

/**
 * Configuration for a single agent in a pipeline.
 */
export interface PipelineAgentConfig<TIn = unknown, TOut = unknown> {
  /** Unique identifier for this agent */
  id: string;
  /** The agent function (unwrapped) */
  fn: (input: TIn) => Promise<TOut> | TOut;
  /** Circuit breaker configuration for this agent */
  breaker?: TieredCircuitBreakerConfig;
  /** Budget limits for this agent */
  budget?: {
    maxTokens?: number;
    maxCalls?: number;
    maxWallClockMs?: number;
    maxCost?: number;
  };
}

/**
 * Behavior when a circuit breaker rejects a contract in the pipeline.
 */
export type PipelineFailureBehavior = 'abort' | 'retry' | 'fallback' | 'degrade';

/**
 * Result of a pipeline execution.
 */
export interface PipelineResult<TFinal> {
  /** Final output from the last agent */
  output: TFinal;
  /** All State Contracts produced during execution */
  contracts: StateContract[];
  /** Whether any contract was flagged as rejected (degrade mode) */
  hadRejected: boolean;
  /** Total execution time in milliseconds */
  totalDurationMs: number;
}

/**
 * Pipeline builder for composing sequential agent handoffs.
 *
 * @example
 * ```ts
 * const pipeline = createPipeline()
 *   .agent('researcher', researchFn, { breaker: { tier: 'L1+L3' } })
 *   .agent('writer', writeFn, { breaker: { tier: 'L1' } })
 *   .onReject('retry', { maxRetries: 2 })
 *   .build();
 *
 * const result = await pipeline.execute({ query: '...' });
 * console.log(result.contracts.length); // 2 (one per agent)
 * console.log(result.output);           // final writer output
 * ```
 */
export class PipelineBuilder {
  private agents: Array<{
    id: string;
    wrapped: WrappedAgent<any, any>;
    config: PipelineAgentConfig;
  }> = [];
  private failureBehavior: PipelineFailureBehavior = 'abort';
  private maxRetries = 2;

  /**
   * Add an agent to the pipeline.
   */
  agent<TIn = unknown, TOut = unknown>(
    id: string,
    fn: (input: TIn) => Promise<TOut> | TOut,
    config?: Omit<PipelineAgentConfig<TIn, TOut>, 'id' | 'fn'>,
  ): PipelineBuilder {
    const fullConfig: PipelineAgentConfig<TIn, TOut> = {
      id,
      fn,
      breaker: config?.breaker,
      budget: config?.budget,
    };

    const wrapped = wrapAgent(fn, {
      id,
      breaker: config?.breaker,
      budget: config?.budget,
    });

    this.agents.push({ id, wrapped, config: fullConfig as any });
    return this;
  }

  /**
   * Set the failure behavior for the entire pipeline.
   */
  onReject(behavior: PipelineFailureBehavior, options?: { maxRetries?: number }): PipelineBuilder {
    this.failureBehavior = behavior;
    if (options?.maxRetries !== undefined) {
      this.maxRetries = options.maxRetries;
    }
    return this;
  }

  /**
   * Build the pipeline executor.
   */
  build<TIn = unknown, TOut = unknown>(): PipelineExecutor<TIn, TOut> {
    return new PipelineExecutor<TIn, TOut>(
      this.agents,
      this.failureBehavior,
      this.maxRetries,
    );
  }
}

/**
 * Execute a pipeline of agents sequentially.
 *
 * Created by PipelineBuilder.build().
 */
export class PipelineExecutor<TIn, TOut> {
  private readonly agents: Array<{
    id: string;
    wrapped: WrappedAgent<any, any>;
    config: PipelineAgentConfig;
  }>;
  private readonly failureBehavior: PipelineFailureBehavior;
  private readonly maxRetries: number;

  constructor(
    agents: Array<{
      id: string;
      wrapped: WrappedAgent<any, any>;
      config: PipelineAgentConfig;
    }>,
    failureBehavior: PipelineFailureBehavior,
    maxRetries: number,
  ) {
    this.agents = agents;
    this.failureBehavior = failureBehavior;
    this.maxRetries = maxRetries;
  }

  /**
   * Execute the pipeline with the given input.
   *
   * Each agent's output becomes the next agent's input via State Contracts.
   *
   * @param input - Initial input for the first agent
   * @returns PipelineResult with final output and all contracts
   */
  async execute(input: TIn): Promise<PipelineResult<TOut>> {
    if (this.agents.length === 0) {
      throw new Error('Pipeline has no agents');
    }

    const start = Date.now();
    const contracts: StateContract[] = [];
    let hadRejected = false;
    let currentInput: unknown = input;

    for (let i = 0; i < this.agents.length; i++) {
      const { id, wrapped } = this.agents[i];

      try {
        const contract = await wrapped(currentInput as any, contracts[0]?.traceId);

        // Check for degraded (rejected but continuing) contracts
        if ((contract.metadata as any)?.validationStatus === 'rejected') {
          hadRejected = true;
        }

        contracts.push(contract);

        // Use the contract's output payload as input for the next agent
        currentInput = contract.outputs.payload;
      } catch (error) {
        if (error instanceof HandoffFailure) {
          const behavior = this.failureBehavior;

          switch (behavior) {
            case 'abort':
              throw error;

            case 'degrade':
              // Continue with the failed contract's data
              hadRejected = true;
              contracts.push(error.contract);
              currentInput = error.contract.outputs.payload;
              break;

            case 'retry': {
              let lastError = error;
              for (let r = 0; r < this.maxRetries; r++) {
                try {
                  const retryContract = await wrapped(currentInput as any, contracts[0]?.traceId);
                  contracts.push(retryContract);
                  currentInput = retryContract.outputs.payload;
                  lastError = null;
                  break;
                } catch (retryErr) {
                  lastError = retryErr as HandoffFailure;
                }
              }
              if (lastError) {
                throw lastError;
              }
              break;
            }

            case 'fallback':
              throw new Error(
                `Pipeline fallback not implemented for agent "${id}". Register a fallback handler.`,
              );
          }
        } else {
          throw error;
        }
      }
    }

    return {
      output: currentInput as TOut,
      contracts,
      hadRejected,
      totalDurationMs: Date.now() - start,
    };
  }
}

/**
 * Create a new pipeline builder.
 *
 * @example
 * ```ts
 * const pipeline = pipeline()
 *   .agent('researcher', researchFn)
 *   .agent('writer', writeFn)
 *   .build();
 *
 * const result = await pipeline.execute({ query: '...' });
 * ```
 */
export function pipeline(): PipelineBuilder {
  return new PipelineBuilder();
}

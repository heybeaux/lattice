/**
 * @heybeaux/lattice-adapter-mastra — Wrap Mastra workflow steps with Lattice coordination.
 *
 * Provides:
 * - `wrapMastraStep()` — wraps a Mastra step config to produce State Contracts
 * - `LatticeStepRunner` — executes steps with Circuit Breaker validation
 * - `tracePipeline()` — instruments an entire Mastra workflow with Lattice
 */

import {
  createContract,
  TieredCircuitBreaker,
  HandoffFailure,
  redactContract,
  EventEmitter,
  globalEmitter,
} from '@heybeaux/lattice-core';
import type {
  TieredCircuitBreakerConfig,
  StateContract,
  TieredValidationResult as ValidationResult,
} from '@heybeaux/lattice-core';
import type { z } from 'zod';

/**
 * A Mastra step-like definition (simplified for adapter purposes).
 * In practice, this mirrors Mastra's Step<TInput, TOutput> interface.
 */
export interface MastraStepLike<TInput = unknown, TOutput = unknown> {
  id: string;
  description?: string;
  inputSchema?: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  execute: (ctx: { inputData: TInput }) => Promise<TOutput>;
}

/**
 * Result of executing a Lattice-wrapped step.
 */
export interface LatticeStepResult<TOutput> {
  /** The step's output */
  output: TOutput;
  /** The State Contract produced by this step */
  contract: StateContract;
  /** Circuit Breaker validation result */
  validation: ValidationResult;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Configuration for wrapping a Mastra step.
 */
export interface WrapMastraStepConfig {
  /** Agent ID (used in State Contract) */
  agentId: string;
  /** Circuit Breaker configuration */
  breaker?: TieredCircuitBreakerConfig;
  /** Whether to redact contracts before emitting events (default: false) */
  redactEvents?: boolean;
}

/**
 * Execution context passed to the wrapped step's execute function.
 * Extends Mastra's context with the current trace ID.
 */
export interface LatticeExecuteContext<TInput> {
  inputData: TInput;
  /** Trace ID from the pipeline (shared across all steps) */
  traceId: string;
  /** Previous step's State Contract (null for first step) */
  previousContract: StateContract | null;
}

/**
 * Wrap a Mastra step to produce State Contracts and validate outputs
 * through Lattice Circuit Breakers.
 *
 * The wrapped step:
 * 1. Receives input and creates a State Contract
 * 2. Executes the original step's `execute` function
 * 3. Creates a State Contract with the output
 * 4. Validates through Circuit Breaker (L1 by default)
 * 5. Emits coordination events
 * 6. Returns LatticeStepResult with output + contract + validation
 *
 * @param step - The Mastra step to wrap
 * @param config - Lattice configuration
 * @returns A new execute function that returns LatticeStepResult
 */
export function wrapMastraStep<TInput, TOutput>(
  step: MastraStepLike<TInput, TOutput>,
  config: WrapMastraStepConfig,
): {
  execute: (ctx: LatticeExecuteContext<TInput>) => Promise<LatticeStepResult<TOutput>>;
} {
  const breaker = new TieredCircuitBreaker(config.breaker);
  const redactEvents = config.redactEvents ?? false;

  const execute = async (
    ctx: LatticeExecuteContext<TInput>,
  ): Promise<LatticeStepResult<TOutput>> => {
    const start = Date.now();

    // Execute the original step
    let output: TOutput;
    let executionError: Error | null = null;

    try {
      output = await step.execute({ inputData: ctx.inputData });
    } catch (err) {
      executionError = err instanceof Error ? err : new Error(String(err));
      // Create a contract recording the failure
      const failedContract = createContract({
        fromAgent: config.agentId,
        traceId: ctx.traceId,
        inputs: ctx.inputData,
        outputs: null as unknown as TOutput,
        constraints: [{
          description: `Step execution failed: ${executionError.message}`,
          severity: 'error',
        }],
        budget: {
          tokensUsed: 0,
          callsMade: 0,
          wallClockMs: Date.now() - start,
        },
      });

      // Emit failure event
      const emitContract = redactEvents ? redactContract(failedContract) : failedContract;
      globalEmitter.contractEmitted(emitContract);

      throw new HandoffFailure(
        `Step "${step.id}" execution failed`,
        { passed: false, tier: 'L1', durationMs: Date.now() - start, reason: 'Step threw exception' },
        failedContract,
      );
    }

    const wallClockMs = Date.now() - start;

    // Create the State Contract
    const contract = createContract<TInput, TOutput>({
      fromAgent: config.agentId,
      traceId: ctx.traceId,
      inputs: ctx.inputData,
      outputs: output,
      budget: {
        tokensUsed: 0, // Would need integration with Mastra's token tracking
        callsMade: 0,
        wallClockMs,
      },
    });

    // Run Circuit Breaker validation
    const validation = await breaker.validate(contract);

    // Emit events
    const emitContract = redactEvents ? redactContract(contract) : contract;
    globalEmitter.contractEmitted(emitContract);

    if (validation.passed) {
      globalEmitter.contractValidated(emitContract, validation.tier);
    } else {
      globalEmitter.contractRejected(emitContract, validation);

      const onReject = config.breaker?.onReject ?? 'abort';
      if (onReject === 'abort') {
        throw new HandoffFailure(
          `Step "${step.id}" output rejected at ${validation.tier}: ${validation.reason}`,
          validation,
          contract,
        );
      }
      // degrade/retry/fallback — continue with flagged contract
    }

    return {
      output,
      contract,
      validation,
      durationMs: wallClockMs,
    };
  };

  return { execute };
}

/**
 * Build a Lattice-instrumented pipeline from Mastra step configs.
 *
 * This is an alternative to Mastra's `createWorkflow` — it provides
 * the same sequential execution model but with full Lattice coordination.
 *
 * @example
 * ```ts
 * const pipeline = createLatticePipeline([
 *   {
 *     step: signalScoutStep,
 *     config: { agentId: 'signal-scout', breaker: { tier: 'L1' } },
 *   },
 *   {
 *     step: angleGenStep,
 *     config: { agentId: 'angle-generator', breaker: { tier: 'L1+L3' } },
 *   },
 * ]);
 *
 * const result = await pipeline.execute({ profileSlug: 'heybeaux-dev' });
 * ```
 */
export function createLatticePipeline(
  steps: Array<{
    step: MastraStepLike<any, any>;
    config: WrapMastraStepConfig;
  }>,
) {
  return {
    /**
     * Execute the pipeline with the given initial input.
     */
    async execute<TInput>(
      input: TInput,
      traceId?: string,
    ): Promise<{
      finalOutput: unknown;
      contracts: StateContract[];
      hadRejected: boolean;
      totalDurationMs: number;
    }> {
      const pipelineTraceId = traceId || createContract({
        fromAgent: '__pipeline__',
        inputs: {},
        outputs: {},
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      }).traceId;

      const start = Date.now();
      const contracts: StateContract[] = [];
      let hadRejected = false;
      let currentInput: unknown = input;

      globalEmitter.pipelineStarted(
        steps.map((s) => s.config.agentId),
        pipelineTraceId,
      );

      for (let i = 0; i < steps.length; i++) {
        const { step, config } = steps[i];
        const previousContract = contracts.length > 0 ? contracts[contracts.length - 1] : null;

        const wrapped = wrapMastraStep(step, config);

        try {
          const result = await wrapped.execute({
            inputData: currentInput,
            traceId: pipelineTraceId,
            previousContract,
          });

          if ((result.contract.metadata as any)?.validationStatus === 'rejected') {
            hadRejected = true;
          }

          contracts.push(result.contract);
          currentInput = result.output;
        } catch (error) {
          if (error instanceof HandoffFailure) {
            const onReject = config.breaker?.onReject ?? 'abort';
            if (onReject === 'degrade') {
              hadRejected = true;
              contracts.push(error.contract);
              currentInput = error.contract.outputs.payload;
            } else {
              globalEmitter.pipelineAborted(
                pipelineTraceId,
                config.agentId,
                (error as HandoffFailure).validation.reason ?? 'Unknown error',
              );
              throw error;
            }
          } else {
            throw error;
          }
        }
      }

      globalEmitter.pipelineCompleted(
        pipelineTraceId,
        contracts.length,
        Date.now() - start,
        hadRejected,
      );

      return {
        finalOutput: currentInput,
        contracts,
        hadRejected,
        totalDurationMs: Date.now() - start,
      };
    },
  };
}

/**
 * Utility: Replay a series of inputs through a Lattice-instrumented pipeline.
 * Useful for benchmarking against golden datasets.
 *
 * @example
 * ```ts
 * const results = await replayPipeline(
 *   pipeline,
 *   goldenDataset.examples.map(ex => ({ input: ex.input, expected: ex.expectedOutput })),
 *   { maxConcurrency: 5 }
 * );
 * ```
 */
export async function replayPipeline<TInput>(
  pipeline: { execute: (input: TInput, traceId?: string) => Promise<any> },
  examples: Array<{ input: TInput; expected?: unknown }>,
  options?: { maxConcurrency?: number },
): Promise<Array<{
  input: TInput;
  output: unknown;
  contracts: StateContract[];
  hadRejected: boolean;
  durationMs: number;
  expected?: unknown;
}>> {
  const maxConcurrency = options?.maxConcurrency ?? 1;
  const results: Array<{
    input: TInput;
    output: unknown;
    contracts: StateContract[];
    hadRejected: boolean;
    durationMs: number;
    expected?: unknown;
  }> = [];

  // Simple sequential replay for now (can be parallelized later)
  for (const example of examples) {
    const pipelineResult = await pipeline.execute(example.input);
    results.push({
      input: example.input,
      output: pipelineResult.finalOutput,
      contracts: pipelineResult.contracts,
      hadRejected: pipelineResult.hadRejected,
      durationMs: pipelineResult.totalDurationMs,
      expected: example.expected,
    });
  }

  return results;
}

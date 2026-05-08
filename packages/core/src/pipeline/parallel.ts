import { StateContract } from '../contract/types.js';
import { createContract } from '../contract/factory.js';
import { wrapAgent, HandoffFailure } from '../wrapper/wrap-agent.js';
import type { WrapAgentConfig } from '../wrapper/wrap-agent.js';


/**
 * Configuration for a single parallel agent branch.
 */
export interface ParallelBranch<TIn = unknown, TOut = unknown> {
  /** Unique identifier for this branch */
  id: string;
  /** Agent function to execute */
  fn: (input: TIn) => Promise<TOut> | TOut;
  /** Circuit breaker configuration for this branch */
  breaker?: WrapAgentConfig<TIn, TOut>['breaker'];
  /** Budget limits for this branch */
  budget?: WrapAgentConfig<TIn, TOut>['budget'];
}

/**
 * Strategy for joining parallel branch outputs.
 */
export type JoinStrategy = 'first' | 'all' | 'majority';

/**
 * Result from executing parallel branches.
 */
export interface ParallelResult<TOut> {
  /** The joined output */
  output: TOut;
  /** State Contracts from all branches */
  contracts: StateContract[];
  /** Whether all branches completed successfully */
  allCompleted: boolean;
  /** Number of branches that succeeded */
  succeeded: number;
  /** Number of branches that failed */
  failed: number;
  /** Total execution time in milliseconds */
  totalDurationMs: number;
}

/**
 * Execute multiple agent branches in parallel and join their outputs.
 *
 * Each branch receives the same input and executes concurrently.
 * The join strategy determines how outputs are merged:
 * - 'all': Returns all outputs as an array
 * - 'first': Returns the first successful output (others still run)
 * - 'majority': Returns the most common output (by JSON equality)
 *
 * @param branches - Array of parallel agent branches
 * @param joinStrategy - How to merge branch outputs (default: 'all')
 * @returns ParallelResult with joined output and per-branch contracts
 */
export async function parallel<TIn, TOut>(
  branches: ParallelBranch<TIn, TOut>[],
  input: TIn,
  joinStrategy: JoinStrategy = 'all',
  traceId?: string,
): Promise<ParallelResult<TOut>> {
  if (branches.length === 0) {
    throw new Error('parallel() requires at least one branch');
  }

  const start = Date.now();
  const contracts: StateContract[] = [];
  let succeeded = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    branches.map(async (branch) => {
      const wrapped = wrapAgent(branch.fn, {
        id: branch.id,
        breaker: branch.breaker,
        budget: branch.budget,
      });

      const contract = await wrapped(input, traceId);
      return contract;
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      contracts.push(result.value);
      succeeded++;
    } else {
      failed++;
      // Create a contract for the failed branch
      if (result.reason instanceof HandoffFailure) {
        contracts.push(result.reason.contract);
      }
    }
  }

  const totalDurationMs = Date.now() - start;
  const outputs = contracts.map(c => c.outputs.payload);
  const output = joinOutputs(outputs, joinStrategy);

  return {
    output: output as TOut,
    contracts,
    allCompleted: failed === 0,
    succeeded,
    failed,
    totalDurationMs,
  };
}

/**
 * Join multiple outputs using the specified strategy.
 */
function joinOutputs<T>(outputs: T[], strategy: JoinStrategy): T | T[] {
  if (outputs.length === 0) {
    throw new Error('No outputs to join');
  }

  switch (strategy) {
    case 'all':
      return outputs as T[];

    case 'first':
      return outputs[0];

    case 'majority': {
      // Find the most common output (by JSON equality)
      const counts = new Map<string, { index: number; count: number }>();
      for (let i = 0; i < outputs.length; i++) {
        const key = JSON.stringify(outputs[i]);
        const existing = counts.get(key);
        if (existing) {
          existing.count++;
        } else {
          counts.set(key, { index: i, count: 1 });
        }
      }

      const majority = Array.from(counts.values()).reduce(
        (a, b) => (a.count > b.count ? a : b),
      );
      return outputs[majority.index];
    }
  }
}

/**
 * Create a pipeline that fans out to parallel branches, then joins them.
 *
 * This is the primary way to build DAGs in Lattice. Use it to compose
 * fan-out/fan-in patterns with full Lattice coordination at every edge.
 *
 * @example
 * ```ts
 * const p = pipelineWithParallel<{ text: string }>()
 *   .agent('preprocess', (input) => ({ processed: input.text.toUpperCase() }))
 *   .parallel([
 *     { id: 'extractor', fn: extractFn },
 *     { id: 'classifier', fn: classifyFn },
 *   ], 'all')
 *   .agent('formatter', (input) => ({ report: JSON.stringify(input) }))
 *   .build();
 *
 * const result = await p.execute({ text: 'hello world' });
 * ```
 */
export function pipelineWithParallel<TIn = unknown>() {
  type AgentStep = {
    id: string;
    fn: (input: unknown) => Promise<unknown> | unknown;
    config?: WrapAgentConfig<any, any>;
  };
  type Step =
    | { type: 'agent'; step: AgentStep }
    | { type: 'parallel'; branches: ParallelBranch[]; strategy: JoinStrategy };

  const steps: Step[] = [];

  return {
    /** Add a sequential agent to the pipeline */
    agent<TIn2 = unknown, TOut2 = unknown>(
      id: string,
      fn: (input: TIn2) => Promise<TOut2> | TOut2,
      config?: Omit<WrapAgentConfig<TIn2, TOut2>, 'id'>,
    ) {
      steps.push({
        type: 'agent',
        step: { id, fn: fn as any, config: config as any },
      });
      return this;
    },

    /** Add a parallel fan-out/fan-in step */
    parallel<TIn2 = unknown, TOut2 = unknown>(
      branches: ParallelBranch<TIn2, TOut2>[],
      strategy: JoinStrategy = 'all',
    ) {
      steps.push({ type: 'parallel', branches: branches as ParallelBranch[], strategy });
      return this;
    },

    /** Build the pipeline executor */
    build() {
      return {
        async execute(input: TIn): Promise<{
          output: unknown;
          contracts: StateContract[];
          totalDurationMs: number;
        }> {
          const start = Date.now();
          const allContracts: StateContract[] = [];
          let currentInput: unknown = input;
          let traceId: string | undefined;

          for (const step of steps) {
            if (step.type === 'agent') {
              const wrapped = wrapAgent(step.step.fn, {
                id: step.step.id,
                breaker: step.step.config?.breaker,
                budget: step.step.config?.budget,
              });
              const contract = await wrapped(currentInput as any, traceId);
              if (!traceId) traceId = contract.traceId;
              allContracts.push(contract);
              currentInput = contract.outputs.payload;
            } else {
              const result = await parallel(
                step.branches,
                currentInput,
                step.strategy,
                traceId,
              );
              if (!traceId && result.contracts.length > 0) {
                traceId = result.contracts[0].traceId;
              }
              allContracts.push(...result.contracts);
              currentInput = result.output;
            }
          }

          return {
            output: currentInput,
            contracts: allContracts,
            totalDurationMs: Date.now() - start,
          };
        },
      };
    },
  };
}

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
 *
 * - `'all'` — return all outputs as an array (default)
 * - `'first'` — return the FIRST SUCCESSFUL output. Branches race; the first
 *   fulfilled wrapped-agent contract wins. The strategy only fails if every
 *   branch fails. (BREAKING in v0.3: prior to this change `'first'` returned
 *   the branch at index 0 regardless of success — see issue #10.)
 * - `'first-position'` — preserves the legacy `'first'` semantics: returns
 *   the output at index 0 of `branches`, even when that branch failed and
 *   later branches succeeded. Use only for deterministic-position semantics.
 * - `'majority'` — most common output by canonical-equality vote.
 */
export type JoinStrategy = 'first' | 'first-position' | 'all' | 'majority';

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

  // Track the FIRST temporally-fulfilled branch so the 'first' strategy can
  // implement true first-success semantics (issue #10). We can't observe
  // settlement order from Promise.allSettled alone — so each branch tags a
  // shared variable on resolve.
  let firstSuccess: StateContract | undefined;

  // Per-branch settled results, indexed by branch position so 'first-position'
  // can recover the legacy ordering.
  const settled: Array<PromiseSettledResult<StateContract>> = await Promise.allSettled(
    branches.map(async (branch) => {
      const wrapped = wrapAgent(branch.fn, {
        id: branch.id,
        breaker: branch.breaker,
        budget: branch.budget,
      });

      const contract = await wrapped(input, traceId);
      // Capture the first temporally successful contract for 'first' strategy.
      if (firstSuccess === undefined) firstSuccess = contract;
      return contract;
    }),
  );

  // Track the per-branch contract (success path or HandoffFailure-attached
  // contract on failure). `byIndex[i]` is undefined when a branch threw a
  // non-HandoffFailure error and produced no contract.
  const byIndex: Array<StateContract | undefined> = new Array(branches.length);

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      contracts.push(result.value);
      byIndex[i] = result.value;
      succeeded++;
    } else {
      failed++;
      if (result.reason instanceof HandoffFailure) {
        contracts.push(result.reason.contract);
        byIndex[i] = result.reason.contract;
      }
    }
  }

  const totalDurationMs = Date.now() - start;
  const output = joinOutputs(settled, byIndex, firstSuccess, joinStrategy);

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
 * Join branch results using the specified strategy.
 *
 * Inputs:
 * - `settled`: per-branch settled results in branch-array order. Used by
 *   `'first-position'` to preserve the legacy "index 0 wins" semantics.
 * - `byIndex`: per-branch contracts (success or HandoffFailure-attached
 *   failure contract). Used by `'all'` and `'majority'` so failed branches
 *   still contribute their failure-marked payload to the join.
 * - `firstSuccess`: the FIRST temporally-fulfilled branch contract. Used by
 *   `'first'` to deliver true first-success semantics (issue #10).
 */
function joinOutputs(
  settled: Array<PromiseSettledResult<StateContract>>,
  byIndex: Array<StateContract | undefined>,
  firstSuccess: StateContract | undefined,
  strategy: JoinStrategy,
): unknown {
  if (settled.length === 0) {
    throw new Error('No outputs to join');
  }

  switch (strategy) {
    case 'all': {
      // Preserve branch order; surface payloads where we have a contract.
      const outs = byIndex.map((c) => c?.outputs.payload);
      return outs;
    }

    case 'first': {
      // True first-success (issue #10): the earliest fulfilled branch wins.
      // If no branch succeeded, surface the failure of the first-position
      // branch so the caller's `allCompleted=false`/`failed>0` signal is
      // accompanied by an explanatory payload — but DO NOT pretend it
      // succeeded. Callers should always check `succeeded > 0` before
      // trusting a 'first' result.
      if (firstSuccess !== undefined) {
        return firstSuccess.outputs.payload;
      }
      // All branches failed. Fall back to the first-position branch's
      // contract payload (which carries the failure) so the return shape
      // stays consistent with `'first-position'`.
      return byIndex[0]?.outputs.payload;
    }

    case 'first-position': {
      // Legacy `'first'` semantics — first-by-index regardless of success.
      // Preserved for callers that genuinely want positional behavior; new
      // code should prefer `'first'` for first-success or `'all'` + manual
      // selection.
      return byIndex[0]?.outputs.payload;
    }

    case 'majority': {
      // Find the most common output (by canonical JSON equality). Only
      // considers branches that produced a contract.
      const counts = new Map<string, { index: number; count: number }>();
      for (let i = 0; i < byIndex.length; i++) {
        const c = byIndex[i];
        if (c === undefined) continue;
        const key = JSON.stringify(c.outputs.payload);
        const existing = counts.get(key);
        if (existing) {
          existing.count++;
        } else {
          counts.set(key, { index: i, count: 1 });
        }
      }

      if (counts.size === 0) {
        // No contracts at all — every branch threw a non-HandoffFailure.
        return undefined;
      }

      const majority = Array.from(counts.values()).reduce(
        (a, b) => (a.count > b.count ? a : b),
      );
      return byIndex[majority.index]?.outputs.payload;
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

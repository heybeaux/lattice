import { ulid } from 'ulidx';
import {
  StateContract,
  ContractPayload,
  Decision,
  Constraint,
  Assumption,
  BudgetRecord,
  CURRENT_SCHEMA_VERSION,
} from './types.js';
import { canonicalize } from '../util/canonical.js';

/** Options for creating a State Contract */
export interface CreateContractOptions<TIn, TOut> {
  /** Identifier of the producing agent */
  fromAgent: string;
  /** Identifier of the consuming agent (null for fan-out) */
  toAgent?: string | null;
  /** Cross-contract correlation ID (auto-generated if not provided) */
  traceId?: string;
  /** Parent contract IDs (for future parallel support) */
  parentIds?: string[];
  /** What the agent received */
  inputs: TIn;
  /** Content type for inputs (default: 'application/json') */
  inputContentType?: string;
  /** What the agent chose and why */
  decisions?: Decision[];
  /** What the agent produced */
  outputs: TOut;
  /** Content type for outputs (default: 'application/json') */
  outputContentType?: string;
  /** What the agent could not do and why */
  constraints?: Constraint[];
  /** What the agent leaves for downstream agents */
  assumptions?: Assumption[];
  /** Resources consumed */
  budget: BudgetRecord;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Creation time (auto-generated if not provided) */
  timestamp?: string;
}

/**
 * Create a State Contract from agent execution results.
 *
 * This is the primary factory for State Contracts. It generates a ULID for the
 * contract id, assigns a traceId (or uses the provided one), and sets the
 * schemaVersion to the current version.
 *
 * @example
 * ```ts
 * const contract = createContract({
 *   fromAgent: 'researcher',
 *   toAgent: 'writer',
 *   inputs: { query: 'latest AI coordination papers' },
 *   outputs: { summary: '...', citations: [...] },
 *   budget: { tokensUsed: 4200, callsMade: 2, wallClockMs: 1850 },
 * });
 * ```
 */
export function createContract<TIn = unknown, TOut = unknown>(
  options: CreateContractOptions<TIn, TOut>,
): StateContract<TIn, TOut> {
  const inputContentType = options.inputContentType ?? 'application/json';
  const outputContentType = options.outputContentType ?? 'application/json';
  const now = options.timestamp ?? new Date().toISOString();

  const inputs: ContractPayload<TIn> = {
    payload: options.inputs,
    contentType: inputContentType,
    contentLength: estimateByteSize(options.inputs),
  };

  const outputs: ContractPayload<TOut> = {
    payload: options.outputs,
    contentType: outputContentType,
    contentLength: estimateByteSize(options.outputs),
  };

  const contract: StateContract<TIn, TOut> = {
    id: ulid(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    traceId: options.traceId ?? ulid(),
    parentIds: options.parentIds ?? [],
    fromAgent: options.fromAgent,
    toAgent: options.toAgent ?? null,
    timestamp: now,
    inputs,
    decisions: options.decisions ?? [],
    outputs,
    constraints: options.constraints ?? [],
    assumptions: options.assumptions ?? [],
    budget: options.budget,
    metadata: options.metadata ?? {},
  };

  return Object.freeze(contract) as StateContract<TIn, TOut>;
}

/**
 * Estimate the byte size of a value by serializing to canonical JSON.
 *
 * Uses {@link canonicalize} (key-sorted, single-pass) rather than
 * `JSON.stringify` so that two semantically-equal payloads with different
 * insertion orders report the same `contentLength` — and so this stringify
 * pass shares a code path with downstream hashers (issue #17).
 */
function estimateByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(canonicalize(value)).length;
  } catch {
    return 0;
  }
}

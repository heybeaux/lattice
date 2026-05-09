import { StateContract } from '../contract/types.js';
import { createContract } from '../contract/factory.js';
import { canonicalize } from '../util/canonical.js';

/**
 * Conflict resolution strategy for the ConsensusReducer.
 */
export type ConflictStrategy = 'majority' | 'first' | 'highest-confidence' | 'flag-only';

/**
 * Configuration for the ConsensusReducer.
 */
export interface ConsensusReducerConfig {
  /** How to resolve conflicts between agent outputs (default: 'majority') */
  conflictStrategy?: ConflictStrategy;
  /** Fields to include in consensus (default: all top-level fields) */
  consensusFields?: string[];
  /** Minimum agreement ratio to accept without flagging (default: 0.6) */
  minAgreementRatio?: number;
  /** Whether to include all individual outputs in the reduced contract metadata */
  includeIndividualOutputs?: boolean;
}

/**
 * Result from reducing multiple agent outputs.
 */
export interface ReduceResult<TOut> {
  /** The consensus output */
  output: TOut;
  /** Conflicts that were detected */
  conflicts: Conflict[];
  /** Whether consensus was reached */
  consensus: boolean;
  /** Agreement ratio (0-1) */
  agreementRatio: number;
  /** Individual agent outputs (only if includeIndividualOutputs is true) */
  individualOutputs?: unknown[];
}

/**
 * A detected conflict between agent outputs.
 */
export interface Conflict {
  /** The field that has conflicting values */
  field: string;
  /** The different values from each agent */
  values: Array<{ agentId: string; value: unknown }>;
  /** How the conflict was resolved */
  resolution: string;
}

/**
 * ConsensusReducer — merges multiple agent outputs into a single validated result.
 *
 * This addresses the #1 failure mode from Silo-Bench: agents can communicate
 * correctly but fail to synthesize distributed state into correct answers.
 *
 * The reducer takes N State Contracts from parallel agents and:
 * 1. Extracts the configured fields from each output
 * 2. Compares values across agents
 * 3. Resolves conflicts using the configured strategy
 * 4. Flags unresolved conflicts in the output metadata
 * 5. Returns a single consensus output
 *
 * @example
 * ```ts
 * const reducer = new ConsensusReducer({
 *   consensusFields: ['summary', 'entities', 'keyPoints'],
 *   conflictStrategy: 'majority',
 *   minAgreementRatio: 0.6,
 * });
 *
 * const result = await reducer.reduce(contracts);
 * console.log(result.output);     // consensus output
 * console.log(result.conflicts);  // any detected conflicts
 * console.log(result.consensus);  // whether agreement was reached
 * ```
 */
export class ConsensusReducer<TOut = unknown> {
  private readonly config: Required<ConsensusReducerConfig>;

  constructor(config?: ConsensusReducerConfig) {
    this.config = {
      conflictStrategy: config?.conflictStrategy ?? 'majority',
      consensusFields: config?.consensusFields ?? [],
      minAgreementRatio: config?.minAgreementRatio ?? 0.6,
      includeIndividualOutputs: config?.includeIndividualOutputs ?? false,
    };
  }

  /**
   * Reduce multiple State Contracts into a single consensus output.
   *
   * @param contracts - State Contracts from parallel agents
   * @param traceId - Shared trace ID for the reduced contract
   * @returns ReduceResult with consensus output and any conflicts
   */
  reduce(
    contracts: StateContract<unknown, TOut>[],
    traceId?: string,
  ): ReduceResult<TOut> {
    if (contracts.length === 0) {
      throw new Error('ConsensusReducer requires at least one contract');
    }

    if (contracts.length === 1) {
      return {
        output: contracts[0].outputs.payload,
        conflicts: [],
        consensus: true,
        agreementRatio: 1.0,
      };
    }

    const outputs = contracts.map(c => c.outputs.payload);
    const fields = this.config.consensusFields.length > 0
      ? this.config.consensusFields
      : this.getCommonFields(outputs);

    const conflicts: Conflict[] = [];
    const consensus: Record<string, unknown> = {};
    let totalAgreements = 0;
    let totalComparisons = 0;

    for (const field of fields) {
      const values = outputs.map((o, i) => ({
        agentId: contracts[i].fromAgent,
        value: (o as any)?.[field],
      }));

      const fieldResult = this.resolveField(field, values, contracts);
      consensus[field] = fieldResult.value;

      if (!fieldResult.resolved) {
        conflicts.push({
          field,
          values,
          resolution: fieldResult.method,
        });
      }

      totalComparisons++;
      if (fieldResult.agreementRatio >= this.config.minAgreementRatio) {
        totalAgreements++;
      }
    }

    const agreementRatio = totalComparisons > 0 ? totalAgreements / totalComparisons : 1;
    const hasConsensus = conflicts.length === 0 || agreementRatio >= this.config.minAgreementRatio;

    const metadata: Record<string, unknown> = {
      reducedFrom: contracts.length,
      agreementRatio,
      conflictCount: conflicts.length,
      conflictStrategy: this.config.conflictStrategy,
    };

    if (this.config.includeIndividualOutputs) {
      metadata.individualOutputs = outputs;
    }

    if (conflicts.length > 0) {
      metadata.conflicts = conflicts.map(c => ({
        field: c.field,
        resolution: c.resolution,
        values: c.values.map(v => ({ agentId: v.agentId, value: String(v.value).slice(0, 100) })),
      }));
    }

    return {
      output: consensus as TOut,
      conflicts,
      consensus: hasConsensus,
      agreementRatio,
      individualOutputs: this.config.includeIndividualOutputs ? outputs : undefined,
    };
  }

  /**
   * Create a State Contract from the reduced output.
   *
   * The reduced contract includes all individual contracts' lineage
   * in the parentIds field, and conflict metadata.
   */
  createReducedContract(
    result: ReduceResult<TOut>,
    contracts: StateContract<unknown, TOut>[],
    fromAgent: string = 'consensus-reducer',
    toAgent: string | null = null,
  ): StateContract<unknown, TOut> {
    const metadata: Record<string, unknown> = {
      reducedFrom: contracts.length,
      agreementRatio: result.agreementRatio,
      conflictCount: result.conflicts.length,
      conflictStrategy: this.config.conflictStrategy,
      isHighRisk: !result.consensus, // Flag as high-risk if no consensus
    };

    if (result.conflicts.length > 0) {
      metadata.conflicts = result.conflicts;
    }

    if (result.individualOutputs) {
      metadata.individualOutputs = result.individualOutputs;
    }

    const assumptions = result.conflicts.map(c => ({
      description: `Field "${c.field}" resolved via ${c.resolution} — ${c.values.length} agents disagreed`,
      riskLevel: 'high' as const,
    }));

    return createContract<unknown, TOut>({
      fromAgent,
      toAgent,
      traceId: contracts[0]?.traceId,
      parentIds: contracts.map(c => c.id),
      inputs: { contracts: contracts.map(c => c.id) },
      outputs: result.output,
      constraints: result.conflicts.map(c => ({
        description: `Conflict on "${c.field}": ${c.values.map(v => `${v.agentId}=${v.value}`).join(', ')}`,
        severity: 'warning' as const,
      })),
      assumptions,
      budget: {
        tokensUsed: 0,
        callsMade: 0,
        wallClockMs: 0,
      },
      metadata,
    });
  }

  /**
   * Get the common fields across all outputs.
   */
  private getCommonFields(outputs: TOut[]): string[] {
    const fieldSets = outputs.map(o => {
      if (o === null || o === undefined || typeof o !== 'object') return new Set<string>();
      return new Set(Object.keys(o));
    });

    const common = new Set(fieldSets[0]);
    for (const fields of fieldSets.slice(1)) {
      for (const key of common) {
        if (!fields.has(key)) {
          common.delete(key);
        }
      }
    }

    return Array.from(common);
  }

  /**
   * Resolve a single field across multiple agent outputs.
   */
  private resolveField(
    field: string,
    values: Array<{ agentId: string; value: unknown }>,
    contracts: StateContract<unknown, TOut>[],
  ): { value: unknown; resolved: boolean; method: string; agreementRatio: number } {
    const uniqueValues = new Map<string, { agentId: string; value: unknown }[]>();

    for (const v of values) {
      const key = this.serializeValue(v.value);
      if (!uniqueValues.has(key)) {
        uniqueValues.set(key, []);
      }
      uniqueValues.get(key)!.push(v);
    }

    // If all agree, return the value
    if (uniqueValues.size === 1) {
      return {
        value: values[0].value,
        resolved: true,
        method: 'unanimous',
        agreementRatio: 1.0,
      };
    }

    // Find the majority group
    const sorted = Array.from(uniqueValues.entries()).sort((a, b) => b[1].length - a[1].length);
    const majority = sorted[0];
    const agreementRatio = majority[1].length / values.length;

    switch (this.config.conflictStrategy) {
      case 'majority':
        return {
          value: majority[1][0].value,
          resolved: agreementRatio >= this.config.minAgreementRatio,
          method: `majority (${majority[1].length}/${values.length} agents)`,
          agreementRatio,
        };

      case 'first':
        return {
          value: values[0].value,
          resolved: false,
          method: 'first-agent (no consensus)',
          agreementRatio,
        };

      case 'highest-confidence':
        // Use the output from the agent with the highest budget (proxy for effort/quality)
        const highestBudget = contracts.reduce((max, c) =>
          c.budget.wallClockMs > max.budget.wallClockMs ? c : max
        , contracts[0]);
        const highestValue = values.find(v => v.agentId === highestBudget.fromAgent);
        return {
          value: highestValue?.value ?? values[0].value,
          resolved: false,
          method: 'highest-confidence (longest-running agent)',
          agreementRatio,
        };

      case 'flag-only':
        return {
          value: majority[1][0].value,
          resolved: false,
          method: 'flag-only (majority selected but not resolved)',
          agreementRatio,
        };

      default:
        return {
          value: majority[1][0].value,
          resolved: agreementRatio >= this.config.minAgreementRatio,
          method: `majority (${majority[1].length}/${values.length} agents)`,
          agreementRatio,
        };
    }
  }

  /**
   * Serialize a value for comparison.
   *
   * Delegates to the shared canonical-stringify utility so that:
   *  - the caller's array is not mutated (fix for #11)
   *  - keys are sorted at every depth, not just the top level (fix for #12)
   *  - the same canonicalization rules are used by the audit-log hash chain
   *
   * Strings retain their previous "raw" treatment (so that two strings only
   * compare equal if they're byte-identical — JSON-quoting them would not
   * change that, but we keep the prior shape to avoid churn in the
   * uniqueValues map keys used by the conflict-resolution logic).
   */
  private serializeValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return canonicalize(value);
  }
}

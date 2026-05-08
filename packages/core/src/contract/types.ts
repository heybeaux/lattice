/**
 * Core types for Lattice State Contracts.
 *
 * A State Contract is the typed envelope that travels between every agent handoff,
 * carrying inputs, decisions, outputs, constraints, and assumptions.
 */

/** Decision types an agent can record */
export type DecisionType =
  | 'action'
  | 'routing'
  | 'fallback'
  | 'escalation'
  | 'other';

/** Severity levels for constraints */
export type ConstraintSeverity = 'info' | 'warning' | 'error';

/** Risk levels for assumptions */
export type RiskLevel = 'low' | 'medium' | 'high';

/** A single decision recorded during agent execution */
export interface Decision {
  type: DecisionType;
  rationale: string;
  timestamp?: string;
  context?: Record<string, unknown>;
}

/** A constraint the agent encountered */
export interface Constraint {
  description: string;
  severity?: ConstraintSeverity;
  context?: Record<string, unknown>;
}

/** An assumption the agent leaves for downstream agents */
export interface Assumption {
  description: string;
  riskLevel?: RiskLevel;
}

/** Resource budget tracking */
export interface BudgetRecord {
  tokensUsed: number;
  callsMade: number;
  wallClockMs: number;
  estimatedCost?: number;
  limit?: {
    maxTokens?: number;
    maxCalls?: number;
    maxWallClockMs?: number;
    maxCost?: number;
  };
}

/** Opaque payload with type information */
export interface ContractPayload<T = unknown> {
  payload: T;
  contentType: string;
  contentLength?: number;
}

/**
 * The State Contract — the core data structure of Lattice.
 *
 * Every agent handoff produces exactly one State Contract, which serves as:
 * - An audit trail (what happened, why, and with what result)
 * - A context carrier (full lineage available to downstream agents)
 * - A validation target (circuit breakers validate contract structure and content)
 */
export interface StateContract<TIn = unknown, TOut = unknown> {
  /** Unique identifier (ULID) */
  id: string;
  /** Envelope schema version (semver, e.g. "0.1.0") */
  schemaVersion: string;
  /** Cross-contract correlation ID for the full pipeline run */
  traceId: string;
  /** Array of upstream contract IDs (for future parallel/merge support) */
  parentIds: string[];
  /** Identifier of the producing agent */
  fromAgent: string;
  /** Identifier of the consuming agent (null for fan-out) */
  toAgent: string | null;
  /** ISO 8601 creation time */
  timestamp: string;
  /** What the agent received */
  inputs: ContractPayload<TIn>;
  /** What the agent chose and why */
  decisions: Decision[];
  /** What the agent produced */
  outputs: ContractPayload<TOut>;
  /** What the agent could not do and why */
  constraints: Constraint[];
  /** What the agent leaves for downstream agents to handle */
  assumptions: Assumption[];
  /** Resources consumed */
  budget: BudgetRecord;
  /** Optional free-form metadata */
  metadata: Record<string, unknown>;
}

/** Current schema version for emitted contracts */
export const CURRENT_SCHEMA_VERSION = '0.1.0' as const;

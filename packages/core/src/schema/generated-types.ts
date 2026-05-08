/**
 * Auto-generated TypeScript types from the State Contract JSON Schema IDL.
 * DO NOT EDIT — run `npx tsx scripts/generate-types.ts` to regenerate.
 *
 * Source: src/schema/contract.schema.json
 * Schema: https://lattice.dev/schemas/state-contract/v0.1.0.json
 */

/**
 * Typed envelope for agent handoff coordination in Lattice. This is the canonical Interface Definition Language (IDL) — TypeScript and Python types are generated from this schema.
 */
export interface StateContract {
  /**
   * Unique identifier (ULID)
   */
  id: string;
  /**
   * Envelope schema version (semver)
   */
  schemaVersion: string;
  /**
   * Cross-contract correlation ID for the full pipeline run
   */
  traceId: string;
  /**
   * Array of upstream contract IDs (for fan-in/parallel merge support)
   */
  parentIds?: string[];
  /**
   * Identifier of the producing agent
   */
  fromAgent: string;
  /**
   * Identifier of the consuming agent (null for fan-out)
   */
  toAgent?: string | null;
  /**
   * ISO 8601 creation time
   */
  timestamp: string;
  inputs: ContractPayload;
  /**
   * Structured reasoning trace
   */
  decisions: Decision[];
  outputs: ContractPayload;
  /**
   * What the agent could not do and why
   */
  constraints: Constraint[];
  /**
   * What the agent leaves for downstream agents to handle
   */
  assumptions: Assumption[];
  budget: BudgetRecord;
  /**
   * Optional free-form key-value pairs
   */
  metadata: {
    [k: string]: any;
  };
}
export interface ContractPayload {
  /**
   * Opaque payload — preserved unchanged
   */
  payload: {
    [k: string]: any;
  };
  /**
   * MIME type or schema URI
   */
  contentType: string;
  /**
   * Approximate size of payload in bytes
   */
  contentLength?: number;
}
export interface Decision {
  type: 'action' | 'routing' | 'fallback' | 'escalation' | 'other';
  /**
   * Why this decision was made
   */
  rationale: string;
  timestamp?: string;
  context?: {
    [k: string]: any;
  };
}
export interface Constraint {
  description: string;
  severity?: 'info' | 'warning' | 'error';
  context?: {
    [k: string]: any;
  };
}
export interface Assumption {
  description: string;
  riskLevel?: 'low' | 'medium' | 'high';
}
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

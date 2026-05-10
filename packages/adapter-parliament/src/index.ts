/**
 * @heybeaux/lattice-adapter-parliament
 *
 * Wraps Parliament's multi-model deliberations with Lattice State Contracts,
 * Circuit Breakers, and ConsensusReducer for coordinated, auditable synthesis.
 */

import {
  createContract,
  TieredCircuitBreaker,
  ConsensusReducer,
  ComplianceAuditLog,
  wrapAgent,
  HandoffFailure,
  EventEmitter,
  globalEmitter,
  redactContract,
} from '@heybeaux/lattice-core';
import type {
  TieredCircuitBreakerConfig,
  ConsensusReducerConfig,
  StateContract,
  EmbeddingProvider,
} from '@heybeaux/lattice-core';

export type { EmbeddingProvider };

// ─── Types ────────────────────────────────────────────────

/**
 * A Parliament model participant.
 */
export interface ParliamentModel {
  /** Unique identifier for the model (e.g., 'claude-opus-4-6') */
  id: string;
  /** Role in the deliberation (proposer, expander, pragmatist, etc.) */
  role: string;
  /** Whether this model is adversarial (skeptic, devils-advocate) */
  isAdversarial?: boolean;
}

/**
 * Configuration for wrapping a Parliament model.
 */
export interface ParliamentModelConfig {
  /** Circuit breaker configuration (defaults: L1+L2 for cooperative, L1 for adversarial) */
  breaker?: TieredCircuitBreakerConfig;
  /** Whether to redact sensitive data before validation (default: true) */
  redactForValidation?: boolean;
  /** Whether to run in shadow mode (validate but don't block) (default: true) */
  shadowMode?: boolean;
}

/**
 * Configuration for the Parliament integration.
 */
export interface ParliamentConfig {
  /** Audit log path (optional — if provided, all deliberations are logged) */
  auditLogPath?: string;
  /** ConsensusReducer configuration */
  reducer?: ConsensusReducerConfig;
  /** Per-model configurations (optional) */
  modelConfigs?: Record<string, ParliamentModelConfig>;
  /** Default model configuration (applied to all models without specific config) */
  defaultModelConfig?: ParliamentModelConfig;
  /** Embedding provider for semantic consensus comparison */
  embeddingProvider?: EmbeddingProvider;
}

/**
 * Result from wrapping a Parliament deliberation.
 */
export interface ParliamentDeliberationResult {
  /** State Contracts for each model response */
  modelContracts: StateContract[];
  /** The consensus/synthesis output */
  consensus: unknown;
  /** Conflicts detected between models */
  conflicts: Array<{
    field: string;
    values: Array<{ agentId: string; value: unknown }>;
    resolution: string;
  }>;
  /** Agreement ratio (0-1) */
  agreementRatio: number;
  /** Whether consensus was reached */
  consensusReached: boolean;
  /** Total deliberation time in milliseconds */
  totalDurationMs: number;
  /** Trace ID for the deliberation */
  traceId: string;
}

// ─── wrapParliamentModel ──────────────────────────────────

/**
 * Wrap a Parliament model call with Lattice State Contracts and Circuit Breakers.
 *
 * The wrapped model:
 * 1. Executes the original model call
 * 2. Creates a State Contract with the model's response
 * 3. Validates through Circuit Breaker (L1+L2 for cooperative, L1 for adversarial)
 * 4. Returns the State Contract
 *
 * @param model - The Parliament model definition
 * @param modelCall - The model call function: (prompt) => Promise<response>
 * @param config - Configuration for this model
 * @returns A wrapped function that returns StateContract instead of raw response
 */
export function wrapParliamentModel(
  model: ParliamentModel,
  modelCall: (prompt: string) => Promise<unknown>,
  config?: ParliamentModelConfig,
) {
  const shadowMode = config?.shadowMode ?? true;
  const breakerConfig = config?.breaker ?? (
    model.isAdversarial
      ? { tier: 'L1' as const }
      : { tier: 'L1+L2' as const, l2Threshold: 0.7 }
  );

  const wrapped = wrapAgent(
    async (prompt: string) => modelCall(prompt),
    {
      id: model.id,
      breaker: breakerConfig,
    },
  );

  return async (
    prompt: string,
    traceId?: string,
  ): Promise<{ contract: StateContract; passed: boolean }> => {
    try {
      const contract = await wrapped(prompt, traceId);
      return { contract, passed: true };
    } catch (error) {
      if (error instanceof HandoffFailure) {
        // In shadow mode, return the failed contract without blocking
        if (shadowMode) {
          return { contract: error.contract, passed: false };
        }
        throw error;
      }
      throw error;
    }
  };
}

// ─── ParliamentCircuitBreaker ─────────────────────────────

/**
 * A pre-configured circuit breaker for Parliament model responses.
 *
 * Cooperative models use L1+L2 validation.
 * Adversarial models use L1 only (they're supposed to be contrarian).
 */
export class ParliamentCircuitBreaker {
  private breakers: Map<string, TieredCircuitBreaker> = new Map();

  constructor(models: ParliamentModel[], configs?: Record<string, TieredCircuitBreakerConfig>) {
    for (const model of models) {
      const config = configs?.[model.id] ?? (
        model.isAdversarial
          ? { tier: 'L1' as const }
          : { tier: 'L1+L2' as const, l2Threshold: 0.7 }
      );
      this.breakers.set(model.id, new TieredCircuitBreaker(config));
    }
  }

  get(agentId: string): TieredCircuitBreaker | undefined {
    return this.breakers.get(agentId);
  }
}

// ─── ParliamentReducer ────────────────────────────────────

/**
 * A ConsensusReducer configured for Parliament synthesis.
 *
 * Detects disagreements between model responses, computes agreement
 * ratios, and flags conflicts for the synthesizer to resolve.
 *
 * When an embeddingProvider is supplied, the consensus fields
 * (mainPoint, supportingArguments, conclusion) are compared using
 * cosine similarity (≥0.85 = agreeing) instead of exact string equality.
 */
export class ParliamentReducer {
  private reducer: ConsensusReducer;

  constructor(config?: ConsensusReducerConfig, embeddingProvider?: EmbeddingProvider) {
    this.reducer = new ConsensusReducer({
      conflictStrategy: config?.conflictStrategy ?? 'flag-only',
      minAgreementRatio: config?.minAgreementRatio ?? 0.6,
      consensusFields: config?.consensusFields ?? ['mainPoint', 'supportingArguments', 'conclusion'],
      includeIndividualOutputs: config?.includeIndividualOutputs ?? true,
      embeddingProvider: embeddingProvider ?? config?.embeddingProvider,
      embeddingThreshold: config?.embeddingThreshold ?? 0.85,
    });
  }

  /**
   * Reduce multiple model responses into a consensus.
   */
  async reduce(
    contracts: StateContract[],
    traceId?: string,
  ): Promise<{
    consensus: unknown;
    conflicts: Array<{
      field: string;
      values: Array<{ agentId: string; value: unknown }>;
      resolution: string;
    }>;
    agreementRatio: number;
    consensusReached: boolean;
    reducedContract: StateContract;
  }> {
    const result = await this.reducer.reduce(contracts);
    const reducedContract = this.reducer.createReducedContract(result, contracts, 'parliament-reducer', null);

    return {
      consensus: result.output,
      conflicts: result.conflicts,
      agreementRatio: result.agreementRatio,
      consensusReached: result.consensus,
      reducedContract,
    };
  }
}

// ─── ParliamentDeliberation ───────────────────────────────

/**
 * Run a full Parliament deliberation with Lattice coordination.
 *
 * @param topic - The deliberation topic
 * @param models - Array of Parliament models to run
 * @param modelCalls - Map of model ID to model call function
 * @param config - Parliament configuration
 * @returns ParliamentDeliberationResult
 */
export async function runParliamentDeliberation(
  topic: string,
  models: ParliamentModel[],
  modelCalls: Map<string, (prompt: string) => Promise<unknown>>,
  config?: ParliamentConfig,
): Promise<ParliamentDeliberationResult> {
  const start = Date.now();
  const traceId = createContract({
    fromAgent: 'parliament-topic',
    inputs: { topic },
    outputs: {},
    budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
  }).traceId;

  // Set up audit log if configured
  let auditLog: ComplianceAuditLog | undefined;
  if (config?.auditLogPath) {
    auditLog = new ComplianceAuditLog({ logPath: config.auditLogPath });
  }

  // Run each model
  const modelContracts: StateContract[] = [];
  const modelResults: Array<{ model: ParliamentModel; result: { contract: StateContract; passed: boolean } }> = [];

  for (const model of models) {
    const modelCall = modelCalls.get(model.id);
    if (!modelCall) {
      continue;
    }

    const modelConfig = config?.modelConfigs?.[model.id] ?? config?.defaultModelConfig;
    const wrappedModel = wrapParliamentModel(model, modelCall, modelConfig);
    const result = await wrappedModel(topic, traceId);

    modelContracts.push(result.contract);
    modelResults.push({ model, result });

    // Log to audit if configured
    if (auditLog) {
      auditLog.append({
        agentId: model.id,
        modelRole: model.role,
        isAdversarial: model.isAdversarial ?? false,
        passed: result.passed,
        traceId,
        contractId: result.contract.id,
      });
    }
  }

  // Run consensus reduction
  const reducer = new ParliamentReducer(config?.reducer, config?.embeddingProvider);
  const reduction = await reducer.reduce(modelContracts, traceId);

  // Log consensus to audit
  if (auditLog) {
    auditLog.append({
      type: 'consensus',
      traceId,
      agreementRatio: reduction.agreementRatio,
      consensusReached: reduction.consensusReached,
      conflictCount: reduction.conflicts.length,
      modelCount: modelContracts.length,
      validModelCount: modelResults.filter(r => r.result.passed).length,
    });
  }

  return {
    modelContracts,
    consensus: reduction.consensus,
    conflicts: reduction.conflicts.map(c => ({
      field: c.field,
      values: c.values.map(v => ({ agentId: v.agentId, value: v.value })),
      resolution: c.resolution,
    })),
    agreementRatio: reduction.agreementRatio,
    consensusReached: reduction.consensusReached,
    totalDurationMs: Date.now() - start,
    traceId,
  };
}



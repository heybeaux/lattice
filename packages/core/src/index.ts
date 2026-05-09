/**
 * @heybeaux/lattice-core — Coordination infrastructure for multi-agent AI systems.
 *
 * Lattice provides State Contracts and Circuit Breakers that make multi-agent
 * systems reliable by solving structural coordination failures.
 *
 * @packageDocumentation
 */

// State Contract types
export type {
  StateContract,
  ContractPayload,
  Decision,
  Constraint,
  Assumption,
  BudgetRecord,
  DecisionType,
  ConstraintSeverity,
  RiskLevel,
} from './contract/types.js';

export { CURRENT_SCHEMA_VERSION } from './contract/types.js';

// Factory
export { createContract } from './contract/factory.js';
export type { CreateContractOptions } from './contract/factory.js';

// Validator
export { SchemaValidator, validateContract } from './contract/validator.js';
export type { ValidationResult as SchemaValidationResult } from './contract/validator.js';
export {
  ContractValidationError,
  SchemaVersionError,
} from './contract/validator.js';

// Circuit Breaker types
export type {
  CircuitState,
  CircuitBreakerConfig,
  CircuitMetrics,
} from './breaker/breaker.js';

export type {
  ValidationTier,
  TieredCircuitBreakerConfig,
  ValidationResult as TieredValidationResult,
  EmbeddingProvider,
  JudgeProvider,
  JudgeResult,
} from './breaker/types.js';

// Circuit Breaker
export { CircuitBreaker } from './breaker/breaker.js';
export { TieredCircuitBreaker } from './breaker/tiered.js';

// wrapAgent
export { wrapAgent, HandoffFailure } from './wrapper/wrap-agent.js';
export type { WrapAgentConfig, WrappedAgent } from './wrapper/wrap-agent.js';

// Pipeline
export { pipeline, PipelineBuilder, PipelineExecutor } from './pipeline/builder.js';
export type {
  PipelineAgentConfig,
  PipelineFailureBehavior,
  PipelineResult,
} from './pipeline/builder.js';

export { parallel, pipelineWithParallel } from './pipeline/parallel.js';
export type {
  ParallelBranch,
  JoinStrategy,
  ParallelResult,
} from './pipeline/parallel.js';

// Events
export { EventEmitter, globalEmitter } from './events/emitter.js';
export type { LatticeEvent, LatticeEventType, LatticeEventHandler } from './events/emitter.js';

// Redaction
export { redactContract } from './events/redact.js';
export type { RedactOptions, SensitivityLevel } from './events/redact.js';

// ConsensusReducer
export { ConsensusReducer } from './reducer/consensus.js';
export type {
  ConsensusReducerConfig,
  ConflictStrategy,
  ReduceResult,
  Conflict,
} from './reducer/consensus.js';

// Compliance
export { ComplianceAuditLog, GENESIS_HASH } from './compliance/audit-log.js';
export type {
  ComplianceConfig,
  AuditLogEntry,
} from './compliance/audit-log.js';

export {
  verifyAuditLog,
  verifyAuditLogDetailed,
  generateVerificationCertificate,
  verifyCertificate,
} from './compliance/verification.js';
export type {
  VerificationResult,
  DetailedVerificationResult,
} from './compliance/verification.js';

export {
  hasPermission,
  getPermissions,
  enforcePermission,
} from './compliance/rbac.js';
export type {
  ComplianceRole,
  CompliancePermission,
} from './compliance/rbac.js';

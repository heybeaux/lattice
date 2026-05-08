/**
 * @lattice/core — Coordination infrastructure for multi-agent AI systems.
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
export type { ValidationResult } from './contract/validator.js';
export {
  ContractValidationError,
  SchemaVersionError,
} from './contract/validator.js';

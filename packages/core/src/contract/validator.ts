import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import schema from '../schema/contract.schema.json' with { type: 'json' };
import { StateContract } from './types.js';

/**
 * Validation result from the schema validator.
 */
export interface ValidationResult {
  /** Whether the contract is valid against the schema */
  valid: boolean;
  /** Schema validation errors (empty if valid) */
  errors: ErrorObject[];
}

/**
 * Schema validator for State Contracts.
 *
 * Uses Ajv for JSON Schema validation. This is the L1 validation tier —
 * deterministic, fast, zero LLM calls.
 */
export class SchemaValidator {
  private ajvValidate: ValidateFunction;

  constructor() {
    const ajv = new Ajv({
      allErrors: true,
      strict: true,
    });
    addFormats(ajv);
    ajv.addSchema(schema);
    // Use the $id from the schema as the reference
    this.ajvValidate = ajv.getSchema(
      'https://lattice.dev/schemas/state-contract/v0.1.0.json',
    )!;
  }

  /**
   * Validate a State Contract against the JSON Schema.
   *
   * @param contract - The contract to validate
   * @returns ValidationResult with valid flag and any errors
   */
  validate(contract: unknown): ValidationResult {
    const valid = this.ajvValidate(contract);
    if (valid) {
      return { valid: true, errors: [] };
    }
    return {
      valid: false,
      errors: (this.ajvValidate.errors ?? []) as ErrorObject[],
    };
  }
}

/**
 * Error thrown when a contract fails validation.
 */
export class ContractValidationError extends Error {
  constructor(
    public readonly errors: ErrorObject[],
    message?: string,
  ) {
    super(
      message ??
        `Contract validation failed: ${errors.map((e) => e.message).join('; ')}`,
    );
    this.name = 'ContractValidationError';
  }
}

/**
 * Error thrown when a contract has a schema version mismatch.
 */
export class SchemaVersionError extends Error {
  constructor(
    public readonly contractVersion: string | undefined,
    public readonly expectedVersion: string,
    message?: string,
  ) {
    super(
      message ??
        `Contract schema version mismatch: contract has "${contractVersion}", runtime expects "${expectedVersion}"`,
    );
    this.name = 'SchemaVersionError';
  }
}

/**
 * Validate a contract against the schema, throwing on failure.
 * Convenience wrapper around SchemaValidator.validate().
 */
export function validateContract(contract: unknown): ValidationResult {
  const validator = new SchemaValidator();
  return validator.validate(contract);
}

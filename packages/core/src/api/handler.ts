/**
 * API input validation handler for Lattice contract creation requests.
 *
 * This module provides the primary input validation layer that guards the
 * contract creation pipeline. All fields are validated for null/undefined
 * before any downstream processing occurs — preventing silent failures and
 * ensuring clear 400-level error messages reach callers.
 *
 * @module api/handler
 */

import { createContract } from '../contract/factory.js';
import { StateContract, BudgetRecord } from '../contract/types.js';
import { validateContract } from '../contract/validator.js';

// ─── Request / Response shapes ────────────────────────────────────────────────

/**
 * Raw incoming request body for contract creation.
 *
 * All top-level fields are typed as `unknown` so that the validation layer
 * — not the type system — enforces the invariants at runtime.
 */
export interface CreateContractRequest {
  fromAgent: unknown;
  toAgent?: unknown;
  traceId?: unknown;
  parentIds?: unknown;
  inputs: unknown;
  inputContentType?: unknown;
  outputs: unknown;
  outputContentType?: unknown;
  decisions?: unknown;
  constraints?: unknown;
  assumptions?: unknown;
  budget: unknown;
  metadata?: unknown;
}

/** A successful handler response carrying the created contract. */
export interface HandlerSuccess {
  ok: true;
  status: 200;
  contract: StateContract;
}

/** A validation-failure handler response with human-readable errors. */
export interface HandlerError {
  ok: false;
  status: 400 | 422 | 500;
  errors: string[];
}

export type HandlerResponse = HandlerSuccess | HandlerError;

// ─── Validation error ─────────────────────────────────────────────────────────

/**
 * Thrown internally when required fields are null, undefined, or of the
 * wrong type. Caught by {@link handleCreateContract} and converted into a
 * 400 HandlerError.
 */
export class InputValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join('; '));
    this.name = 'InputValidationError';
    this.errors = errors;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Field validators ─────────────────────────────────────────────────────────

/**
 * Collect every null/undefined/wrong-type violation in the request body
 * and return them as a list of human-readable error strings.
 *
 * Returns an empty array when the request is valid.
 */
export function collectValidationErrors(body: CreateContractRequest): string[] {
  const errors: string[] = [];

  // fromAgent: required, non-empty string
  if (body.fromAgent === null || body.fromAgent === undefined) {
    errors.push('fromAgent is required');
  } else if (typeof body.fromAgent !== 'string') {
    errors.push('fromAgent must be a string');
  } else if (body.fromAgent.trim() === '') {
    errors.push('fromAgent must not be an empty string');
  }

  // toAgent: optional, but must be string or null when present
  if (body.toAgent !== undefined) {
    if (body.toAgent !== null && typeof body.toAgent !== 'string') {
      errors.push('toAgent must be a string or null');
    }
  }

  // traceId: optional, must be a string when present
  if (body.traceId !== undefined && body.traceId !== null) {
    if (typeof body.traceId !== 'string') {
      errors.push('traceId must be a string');
    } else if (body.traceId.trim() === '') {
      errors.push('traceId must not be an empty string');
    }
  }

  // parentIds: optional array of strings
  if (body.parentIds !== undefined && body.parentIds !== null) {
    if (!Array.isArray(body.parentIds)) {
      errors.push('parentIds must be an array');
    } else {
      body.parentIds.forEach((id: unknown, i: number) => {
        if (typeof id !== 'string' || id.trim() === '') {
          errors.push(`parentIds[${i}] must be a non-empty string`);
        }
      });
    }
  }

  // inputs: required, must not be null or undefined
  if (body.inputs === null || body.inputs === undefined) {
    errors.push('inputs is required');
  }

  // inputContentType: optional, must be a string when present
  if (body.inputContentType !== undefined && body.inputContentType !== null) {
    if (typeof body.inputContentType !== 'string') {
      errors.push('inputContentType must be a string');
    }
  }

  // outputs: required, must not be null or undefined
  if (body.outputs === null || body.outputs === undefined) {
    errors.push('outputs is required');
  }

  // outputContentType: optional, must be a string when present
  if (body.outputContentType !== undefined && body.outputContentType !== null) {
    if (typeof body.outputContentType !== 'string') {
      errors.push('outputContentType must be a string');
    }
  }

  // budget: required object with numeric sub-fields
  if (body.budget === null || body.budget === undefined) {
    errors.push('budget is required');
  } else if (typeof body.budget !== 'object' || Array.isArray(body.budget)) {
    errors.push('budget must be an object');
  } else {
    const b = body.budget as Record<string, unknown>;

    if (b['tokensUsed'] === null || b['tokensUsed'] === undefined) {
      errors.push('budget.tokensUsed is required');
    } else if (typeof b['tokensUsed'] !== 'number' || !Number.isFinite(b['tokensUsed'])) {
      errors.push('budget.tokensUsed must be a finite number');
    }

    if (b['callsMade'] === null || b['callsMade'] === undefined) {
      errors.push('budget.callsMade is required');
    } else if (typeof b['callsMade'] !== 'number' || !Number.isFinite(b['callsMade'])) {
      errors.push('budget.callsMade must be a finite number');
    }

    if (b['wallClockMs'] === null || b['wallClockMs'] === undefined) {
      errors.push('budget.wallClockMs is required');
    } else if (typeof b['wallClockMs'] !== 'number' || !Number.isFinite(b['wallClockMs'])) {
      errors.push('budget.wallClockMs must be a finite number');
    }
  }

  // decisions: optional array
  if (body.decisions !== undefined && body.decisions !== null) {
    if (!Array.isArray(body.decisions)) {
      errors.push('decisions must be an array');
    }
  }

  // constraints: optional array
  if (body.constraints !== undefined && body.constraints !== null) {
    if (!Array.isArray(body.constraints)) {
      errors.push('constraints must be an array');
    }
  }

  // assumptions: optional array
  if (body.assumptions !== undefined && body.assumptions !== null) {
    if (!Array.isArray(body.assumptions)) {
      errors.push('assumptions must be an array');
    }
  }

  // metadata: optional object (not array)
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      errors.push('metadata must be a plain object');
    }
  }

  return errors;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Validate incoming request data and create a Lattice State Contract.
 *
 * This is the main entry point for the API layer. It:
 * 1. Checks every required field for null/undefined and wrong type (400)
 * 2. Passes the validated data to `createContract`
 * 3. Re-validates the produced contract against the JSON Schema (422)
 * 4. Returns the contract on success (200)
 *
 * Callers should never receive a partially-constructed contract — all
 * validation happens before any processing.
 *
 * @example
 * ```ts
 * const response = await handleCreateContract({
 *   fromAgent: 'researcher',
 *   inputs: { query: 'latest AI papers' },
 *   outputs: { summary: '...' },
 *   budget: { tokensUsed: 1200, callsMade: 1, wallClockMs: 400 },
 * });
 *
 * if (!response.ok) {
 *   // response.status is 400 or 422
 *   console.error(response.errors);
 * } else {
 *   // response.contract is a fully validated StateContract
 *   doSomething(response.contract);
 * }
 * ```
 */
export async function handleCreateContract(
  body: CreateContractRequest | null | undefined,
): Promise<HandlerResponse> {
  // Guard: the entire body must be present
  if (body === null || body === undefined) {
    return {
      ok: false,
      status: 400,
      errors: ['Request body is required'],
    };
  }

  // Collect all field-level validation errors before doing any work
  const fieldErrors = collectValidationErrors(body);
  if (fieldErrors.length > 0) {
    return {
      ok: false,
      status: 400,
      errors: fieldErrors,
    };
  }

  // At this point every required field is present and correctly typed.
  // Cast to known-good types for `createContract`.
  try {
    const budget = body.budget as Record<string, unknown>;

    const contract = createContract({
      fromAgent: body.fromAgent as string,
      toAgent:
        body.toAgent !== undefined
          ? (body.toAgent as string | null)
          : undefined,
      traceId:
        body.traceId !== undefined && body.traceId !== null
          ? (body.traceId as string)
          : undefined,
      parentIds:
        body.parentIds !== undefined && body.parentIds !== null
          ? (body.parentIds as string[])
          : undefined,
      inputs: body.inputs,
      inputContentType:
        body.inputContentType !== undefined && body.inputContentType !== null
          ? (body.inputContentType as string)
          : undefined,
      outputs: body.outputs,
      outputContentType:
        body.outputContentType !== undefined && body.outputContentType !== null
          ? (body.outputContentType as string)
          : undefined,
      decisions:
        body.decisions !== undefined && body.decisions !== null
          ? (body.decisions as any[])
          : undefined,
      constraints:
        body.constraints !== undefined && body.constraints !== null
          ? (body.constraints as any[])
          : undefined,
      assumptions:
        body.assumptions !== undefined && body.assumptions !== null
          ? (body.assumptions as any[])
          : undefined,
      budget: {
        tokensUsed: budget['tokensUsed'] as number,
        callsMade: budget['callsMade'] as number,
        wallClockMs: budget['wallClockMs'] as number,
        estimatedCost:
          typeof budget['estimatedCost'] === 'number'
            ? (budget['estimatedCost'] as number)
            : undefined,
      } satisfies BudgetRecord,
      metadata:
        body.metadata !== undefined && body.metadata !== null
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    });

    // Run the JSON Schema validation pass as a final safety net
    const schemaResult = validateContract(contract);
    if (!schemaResult.valid) {
      return {
        ok: false,
        status: 422,
        errors: schemaResult.errors.map(
          (e) => `${e.instancePath || '(root)'}: ${e.message ?? 'schema violation'}`,
        ),
      };
    }

    return { ok: true, status: 200, contract };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

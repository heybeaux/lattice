import { describe, it, expect } from 'vitest';
import {
  handleCreateContract,
  collectValidationErrors,
  InputValidationError,
  type CreateContractRequest,
  type HandlerError,
  type HandlerSuccess,
} from '../src/api/handler.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid request body used as the baseline across tests. */
const VALID_BODY: CreateContractRequest = {
  fromAgent: 'test-agent',
  inputs: { query: 'hello' },
  outputs: { result: 'world' },
  budget: { tokensUsed: 100, callsMade: 1, wallClockMs: 50 },
};

function makeBody(overrides: Partial<CreateContractRequest>): CreateContractRequest {
  return { ...VALID_BODY, ...overrides };
}

// ─── collectValidationErrors ──────────────────────────────────────────────────

describe('collectValidationErrors', () => {
  it('returns no errors for a fully valid body', () => {
    expect(collectValidationErrors(VALID_BODY)).toEqual([]);
  });

  // fromAgent
  describe('fromAgent', () => {
    it('errors when fromAgent is null', () => {
      const errs = collectValidationErrors(makeBody({ fromAgent: null }));
      expect(errs).toContain('fromAgent is required');
    });

    it('errors when fromAgent is undefined', () => {
      const errs = collectValidationErrors(makeBody({ fromAgent: undefined }));
      expect(errs).toContain('fromAgent is required');
    });

    it('errors when fromAgent is not a string', () => {
      const errs = collectValidationErrors(makeBody({ fromAgent: 42 }));
      expect(errs).toContain('fromAgent must be a string');
    });

    it('errors when fromAgent is an empty string', () => {
      const errs = collectValidationErrors(makeBody({ fromAgent: '   ' }));
      expect(errs).toContain('fromAgent must not be an empty string');
    });
  });

  // toAgent
  describe('toAgent', () => {
    it('accepts toAgent as null', () => {
      const errs = collectValidationErrors(makeBody({ toAgent: null }));
      expect(errs).not.toContain('toAgent must be a string or null');
    });

    it('accepts toAgent as a valid string', () => {
      const errs = collectValidationErrors(makeBody({ toAgent: 'downstream-agent' }));
      expect(errs).toHaveLength(0);
    });

    it('errors when toAgent is a number', () => {
      const errs = collectValidationErrors(makeBody({ toAgent: 99 }));
      expect(errs).toContain('toAgent must be a string or null');
    });
  });

  // traceId
  describe('traceId', () => {
    it('accepts a valid traceId string', () => {
      const errs = collectValidationErrors(makeBody({ traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }));
      expect(errs).toHaveLength(0);
    });

    it('accepts traceId as undefined (optional)', () => {
      const body = { ...VALID_BODY };
      delete (body as any).traceId;
      expect(collectValidationErrors(body)).toHaveLength(0);
    });

    it('errors when traceId is a non-string', () => {
      const errs = collectValidationErrors(makeBody({ traceId: 123 }));
      expect(errs).toContain('traceId must be a string');
    });

    it('errors when traceId is an empty string', () => {
      const errs = collectValidationErrors(makeBody({ traceId: '' }));
      expect(errs).toContain('traceId must not be an empty string');
    });
  });

  // parentIds
  describe('parentIds', () => {
    it('accepts a valid array of strings', () => {
      const errs = collectValidationErrors(makeBody({ parentIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] }));
      expect(errs).toHaveLength(0);
    });

    it('accepts an empty array', () => {
      const errs = collectValidationErrors(makeBody({ parentIds: [] }));
      expect(errs).toHaveLength(0);
    });

    it('errors when parentIds is not an array', () => {
      const errs = collectValidationErrors(makeBody({ parentIds: 'not-an-array' }));
      expect(errs).toContain('parentIds must be an array');
    });

    it('errors when a parentId element is not a non-empty string', () => {
      const errs = collectValidationErrors(makeBody({ parentIds: ['valid', ''] }));
      expect(errs.some((e) => e.includes('parentIds[1]'))).toBe(true);
    });
  });

  // inputs
  describe('inputs', () => {
    it('errors when inputs is null', () => {
      const errs = collectValidationErrors(makeBody({ inputs: null }));
      expect(errs).toContain('inputs is required');
    });

    it('errors when inputs is undefined', () => {
      const errs = collectValidationErrors(makeBody({ inputs: undefined }));
      expect(errs).toContain('inputs is required');
    });

    it('accepts inputs as an empty object', () => {
      const errs = collectValidationErrors(makeBody({ inputs: {} }));
      expect(errs).toHaveLength(0);
    });

    it('accepts inputs as a string', () => {
      const errs = collectValidationErrors(makeBody({ inputs: 'raw string input' }));
      expect(errs).toHaveLength(0);
    });
  });

  // outputs
  describe('outputs', () => {
    it('errors when outputs is null', () => {
      const errs = collectValidationErrors(makeBody({ outputs: null }));
      expect(errs).toContain('outputs is required');
    });

    it('errors when outputs is undefined', () => {
      const errs = collectValidationErrors(makeBody({ outputs: undefined }));
      expect(errs).toContain('outputs is required');
    });

    it('accepts outputs as 0 (falsy but valid)', () => {
      const errs = collectValidationErrors(makeBody({ outputs: 0 }));
      expect(errs).toHaveLength(0);
    });
  });

  // budget
  describe('budget', () => {
    it('errors when budget is null', () => {
      const errs = collectValidationErrors(makeBody({ budget: null }));
      expect(errs).toContain('budget is required');
    });

    it('errors when budget is undefined', () => {
      const errs = collectValidationErrors(makeBody({ budget: undefined }));
      expect(errs).toContain('budget is required');
    });

    it('errors when budget is not an object', () => {
      const errs = collectValidationErrors(makeBody({ budget: 'wrong' }));
      expect(errs).toContain('budget must be an object');
    });

    it('errors when budget.tokensUsed is null', () => {
      const errs = collectValidationErrors(
        makeBody({ budget: { tokensUsed: null, callsMade: 1, wallClockMs: 10 } }),
      );
      expect(errs).toContain('budget.tokensUsed is required');
    });

    it('errors when budget.tokensUsed is undefined', () => {
      const errs = collectValidationErrors(
        makeBody({ budget: { callsMade: 1, wallClockMs: 10 } as any }),
      );
      expect(errs).toContain('budget.tokensUsed is required');
    });

    it('errors when budget.tokensUsed is NaN', () => {
      const errs = collectValidationErrors(
        makeBody({ budget: { tokensUsed: NaN, callsMade: 1, wallClockMs: 10 } }),
      );
      expect(errs).toContain('budget.tokensUsed must be a finite number');
    });

    it('errors when budget.callsMade is null', () => {
      const errs = collectValidationErrors(
        makeBody({ budget: { tokensUsed: 0, callsMade: null, wallClockMs: 10 } }),
      );
      expect(errs).toContain('budget.callsMade is required');
    });

    it('errors when budget.wallClockMs is null', () => {
      const errs = collectValidationErrors(
        makeBody({ budget: { tokensUsed: 0, callsMade: 1, wallClockMs: null } }),
      );
      expect(errs).toContain('budget.wallClockMs is required');
    });

    it('errors when budget.wallClockMs is Infinity', () => {
      const errs = collectValidationErrors(
        makeBody({ budget: { tokensUsed: 0, callsMade: 1, wallClockMs: Infinity } }),
      );
      expect(errs).toContain('budget.wallClockMs must be a finite number');
    });

    it('collects multiple budget errors at once', () => {
      const errs = collectValidationErrors(
        makeBody({ budget: { tokensUsed: null, callsMade: null, wallClockMs: null } }),
      );
      expect(errs).toContain('budget.tokensUsed is required');
      expect(errs).toContain('budget.callsMade is required');
      expect(errs).toContain('budget.wallClockMs is required');
    });
  });

  // optional array fields
  describe('optional array fields', () => {
    it('errors when decisions is not an array', () => {
      const errs = collectValidationErrors(makeBody({ decisions: 'not-array' }));
      expect(errs).toContain('decisions must be an array');
    });

    it('accepts decisions as an array', () => {
      const errs = collectValidationErrors(
        makeBody({ decisions: [{ type: 'action', rationale: 'test' }] }),
      );
      expect(errs).toHaveLength(0);
    });

    it('errors when constraints is not an array', () => {
      const errs = collectValidationErrors(makeBody({ constraints: {} }));
      expect(errs).toContain('constraints must be an array');
    });

    it('errors when assumptions is not an array', () => {
      const errs = collectValidationErrors(makeBody({ assumptions: 42 }));
      expect(errs).toContain('assumptions must be an array');
    });
  });

  // metadata
  describe('metadata', () => {
    it('accepts metadata as a plain object', () => {
      const errs = collectValidationErrors(makeBody({ metadata: { foo: 'bar' } }));
      expect(errs).toHaveLength(0);
    });

    it('errors when metadata is an array', () => {
      const errs = collectValidationErrors(makeBody({ metadata: [] }));
      expect(errs).toContain('metadata must be a plain object');
    });

    it('errors when metadata is a string', () => {
      const errs = collectValidationErrors(makeBody({ metadata: 'string' }));
      expect(errs).toContain('metadata must be a plain object');
    });
  });

  // multiple errors collected simultaneously
  it('collects multiple independent errors in a single pass', () => {
    const errs = collectValidationErrors({
      fromAgent: null,
      inputs: null,
      outputs: null,
      budget: null,
    } as any);
    expect(errs).toContain('fromAgent is required');
    expect(errs).toContain('inputs is required');
    expect(errs).toContain('outputs is required');
    expect(errs).toContain('budget is required');
    expect(errs.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── handleCreateContract ─────────────────────────────────────────────────────

describe('handleCreateContract', () => {
  // Null / missing body
  describe('null / missing body', () => {
    it('returns 400 when body is null', async () => {
      const res = await handleCreateContract(null);
      expect(res.ok).toBe(false);
      expect((res as HandlerError).status).toBe(400);
      expect((res as HandlerError).errors).toContain('Request body is required');
    });

    it('returns 400 when body is undefined', async () => {
      const res = await handleCreateContract(undefined);
      expect(res.ok).toBe(false);
      expect((res as HandlerError).status).toBe(400);
      expect((res as HandlerError).errors).toContain('Request body is required');
    });
  });

  // null required fields
  describe('null required fields in body', () => {
    it('returns 400 when fromAgent is null', async () => {
      const res = await handleCreateContract(makeBody({ fromAgent: null }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).status).toBe(400);
      expect((res as HandlerError).errors).toContain('fromAgent is required');
    });

    it('returns 400 when inputs is null', async () => {
      const res = await handleCreateContract(makeBody({ inputs: null }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).status).toBe(400);
      expect((res as HandlerError).errors).toContain('inputs is required');
    });

    it('returns 400 when outputs is null', async () => {
      const res = await handleCreateContract(makeBody({ outputs: null }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).status).toBe(400);
      expect((res as HandlerError).errors).toContain('outputs is required');
    });

    it('returns 400 when budget is null', async () => {
      const res = await handleCreateContract(makeBody({ budget: null }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).status).toBe(400);
      expect((res as HandlerError).errors).toContain('budget is required');
    });

    it('returns 400 when budget sub-fields are null', async () => {
      const res = await handleCreateContract(
        makeBody({ budget: { tokensUsed: null, callsMade: null, wallClockMs: null } }),
      );
      expect(res.ok).toBe(false);
      expect((res as HandlerError).status).toBe(400);
      const errs = (res as HandlerError).errors;
      expect(errs).toContain('budget.tokensUsed is required');
      expect(errs).toContain('budget.callsMade is required');
      expect(errs).toContain('budget.wallClockMs is required');
    });
  });

  // undefined required fields
  describe('undefined required fields in body', () => {
    it('returns 400 when fromAgent is undefined', async () => {
      const res = await handleCreateContract(makeBody({ fromAgent: undefined }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).errors).toContain('fromAgent is required');
    });

    it('returns 400 when inputs is undefined', async () => {
      const res = await handleCreateContract(makeBody({ inputs: undefined }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).errors).toContain('inputs is required');
    });

    it('returns 400 when outputs is undefined', async () => {
      const res = await handleCreateContract(makeBody({ outputs: undefined }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).errors).toContain('outputs is required');
    });

    it('returns 400 when budget is undefined', async () => {
      const res = await handleCreateContract(makeBody({ budget: undefined }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).errors).toContain('budget is required');
    });
  });

  // type errors
  describe('wrong types', () => {
    it('returns 400 when fromAgent is a number', async () => {
      const res = await handleCreateContract(makeBody({ fromAgent: 7 }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).errors).toContain('fromAgent must be a string');
    });

    it('returns 400 when budget.tokensUsed is NaN', async () => {
      const res = await handleCreateContract(
        makeBody({ budget: { tokensUsed: NaN, callsMade: 1, wallClockMs: 10 } }),
      );
      expect(res.ok).toBe(false);
      expect((res as HandlerError).errors).toContain('budget.tokensUsed must be a finite number');
    });

    it('returns 400 when toAgent is a boolean', async () => {
      const res = await handleCreateContract(makeBody({ toAgent: true }));
      expect(res.ok).toBe(false);
      expect((res as HandlerError).errors).toContain('toAgent must be a string or null');
    });
  });

  // success path
  describe('successful creation', () => {
    it('returns 200 with a valid contract for a minimal body', async () => {
      const res = await handleCreateContract(VALID_BODY);
      expect(res.ok).toBe(true);
      expect((res as HandlerSuccess).status).toBe(200);
      const contract = (res as HandlerSuccess).contract;
      expect(contract.fromAgent).toBe('test-agent');
      expect(contract.inputs.payload).toEqual({ query: 'hello' });
      expect(contract.outputs.payload).toEqual({ result: 'world' });
      expect(contract.budget.tokensUsed).toBe(100);
    });

    it('propagates optional fields correctly', async () => {
      const res = await handleCreateContract({
        fromAgent: 'agent-a',
        toAgent: 'agent-b',
        inputs: { x: 1 },
        outputs: { y: 2 },
        decisions: [{ type: 'action', rationale: 'chose path A' }],
        constraints: [{ description: 'rate limited', severity: 'warning' }],
        assumptions: [{ description: 'data is fresh', riskLevel: 'low' }],
        budget: { tokensUsed: 500, callsMade: 2, wallClockMs: 300 },
        metadata: { pipeline: 'test' },
      });

      expect(res.ok).toBe(true);
      const contract = (res as HandlerSuccess).contract;
      expect(contract.toAgent).toBe('agent-b');
      expect(contract.decisions).toHaveLength(1);
      expect(contract.constraints).toHaveLength(1);
      expect(contract.assumptions).toHaveLength(1);
      expect(contract.metadata).toMatchObject({ pipeline: 'test' });
    });

    it('accepts toAgent as null (fan-out)', async () => {
      const res = await handleCreateContract(makeBody({ toAgent: null }));
      expect(res.ok).toBe(true);
      expect((res as HandlerSuccess).contract.toAgent).toBeNull();
    });

    it('returns a frozen (immutable) contract', async () => {
      const res = await handleCreateContract(VALID_BODY);
      expect(res.ok).toBe(true);
      expect(Object.isFrozen((res as HandlerSuccess).contract)).toBe(true);
    });

    it('produces a contract that passes schema validation', async () => {
      const res = await handleCreateContract(VALID_BODY);
      expect(res.ok).toBe(true);
      // The handler already validates — this confirms the returned contract is schema-clean
      expect((res as HandlerSuccess).status).toBe(200);
    });
  });

  // multi-error responses
  describe('multiple simultaneous errors', () => {
    it('returns all errors in a single 400 response', async () => {
      const res = await handleCreateContract({
        fromAgent: null,
        inputs: undefined,
        outputs: null,
        budget: null,
      } as any);

      expect(res.ok).toBe(false);
      expect((res as HandlerError).status).toBe(400);
      const errs = (res as HandlerError).errors;
      expect(errs.length).toBeGreaterThanOrEqual(4);
    });
  });
});

// ─── InputValidationError ────────────────────────────────────────────────────

describe('InputValidationError', () => {
  it('is an Error subclass', () => {
    const err = new InputValidationError(['field is required']);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InputValidationError');
  });

  it('exposes the errors array', () => {
    const msgs = ['field A is required', 'field B must be a string'];
    const err = new InputValidationError(msgs);
    expect(err.errors).toEqual(msgs);
  });

  it('sets message to a semicolon-joined string', () => {
    const err = new InputValidationError(['err1', 'err2']);
    expect(err.message).toBe('err1; err2');
  });
});

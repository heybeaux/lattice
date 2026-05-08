import { describe, it, expect } from 'vitest';
import {
  createContract,
  validateContract,
  SchemaValidator,
  CURRENT_SCHEMA_VERSION,
  ContractValidationError,
} from '../src/index.js';

describe('createContract', () => {
  it('creates a valid contract with minimal options', () => {
    const contract = createContract({
      fromAgent: 'test-agent',
      inputs: { query: 'hello' },
      outputs: { result: 'world' },
      budget: { tokensUsed: 100, callsMade: 1, wallClockMs: 50 },
    });

    expect(contract.id).toHaveLength(26);
    expect(contract.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(contract.fromAgent).toBe('test-agent');
    expect(contract.toAgent).toBeNull();
    expect(contract.parentIds).toEqual([]);
    expect(contract.inputs.payload).toEqual({ query: 'hello' });
    expect(contract.outputs.payload).toEqual({ result: 'world' });
    expect(contract.decisions).toEqual([]);
    expect(contract.constraints).toEqual([]);
    expect(contract.assumptions).toEqual([]);
    expect(contract.metadata).toEqual({});
  });

  it('assigns a traceId if not provided', () => {
    const c1 = createContract({
      fromAgent: 'a',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });
    const c2 = createContract({
      fromAgent: 'a',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    expect(c1.traceId).toHaveLength(26);
    expect(c1.traceId).not.toBe(c2.traceId);
  });

  it('reuses traceId when provided', () => {
    const traceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const contract = createContract({
      fromAgent: 'a',
      traceId,
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    expect(contract.traceId).toBe(traceId);
  });

  it('accepts custom timestamp', () => {
    const ts = '2026-05-08T00:00:00.000Z';
    const contract = createContract({
      fromAgent: 'a',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      timestamp: ts,
    });

    expect(contract.timestamp).toBe(ts);
  });

  it('includes decisions, constraints, and assumptions', () => {
    const contract = createContract({
      fromAgent: 'agent-1',
      toAgent: 'agent-2',
      inputs: { task: 'analyze' },
      decisions: [{ type: 'action', rationale: 'chose analysis path' }],
      outputs: { findings: ['x', 'y'] },
      constraints: [{ description: 'limited to 3 results', severity: 'warning' }],
      assumptions: [{ description: 'input data is current', riskLevel: 'low' }],
      budget: { tokensUsed: 500, callsMade: 2, wallClockMs: 200 },
      metadata: { pipeline: 'test' },
    });

    expect(contract.decisions).toHaveLength(1);
    expect(contract.decisions[0].type).toBe('action');
    expect(contract.constraints[0].severity).toBe('warning');
    expect(contract.assumptions[0].riskLevel).toBe('low');
    expect(contract.metadata).toEqual({ pipeline: 'test' });
    expect(contract.toAgent).toBe('agent-2');
  });

  it('estimates content length', () => {
    const contract = createContract({
      fromAgent: 'a',
      inputs: { data: 'hello world' },
      outputs: { result: 42 },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    expect(contract.inputs.contentLength).toBeGreaterThan(0);
    expect(contract.outputs.contentLength).toBeGreaterThan(0);
  });

  it('freezes the contract (immutability)', () => {
    const contract = createContract({
      fromAgent: 'a',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    expect(Object.isFrozen(contract)).toBe(true);
    expect(() => {
      (contract as any).fromAgent = 'hacked';
    }).toThrow();
  });
});

describe('validateContract', () => {
  it('validates a correct contract', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: { x: 1 },
      outputs: { y: 2 },
      budget: { tokensUsed: 10, callsMade: 1, wallClockMs: 5 },
    });

    const result = validateContract(contract);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a contract with missing required fields', () => {
    const incomplete = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      schemaVersion: '0.1.0',
      // missing traceId, fromAgent, etc.
    };

    const result = validateContract(incomplete);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a contract with wrong schemaVersion format', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const bad = { ...contract, schemaVersion: 'invalid' } as any;
    const result = validateContract(bad);
    expect(result.valid).toBe(false);
  });

  it('rejects a contract with extra properties', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const bad = { ...contract, extraField: 'oops' } as any;
    const result = validateContract(bad);
    expect(result.valid).toBe(false);
  });

  it('rejects a contract with null required fields', () => {
    const bad = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      schemaVersion: '0.1.0',
      traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      fromAgent: null, // should be string, not null
      timestamp: '2026-05-08T00:00:00.000Z',
      inputs: { payload: null, contentType: 'application/json' },
      decisions: [],
      outputs: { payload: null, contentType: 'application/json' },
      constraints: [],
      assumptions: [],
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      metadata: {},
    };

    const result = validateContract(bad);
    expect(result.valid).toBe(false);
  });
});

describe('SchemaValidator', () => {
  it('validates multiple contracts with the same instance', () => {
    const validator = new SchemaValidator();

    const c1 = createContract({
      fromAgent: 'a',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });
    const c2 = createContract({
      fromAgent: 'b',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    expect(validator.validate(c1).valid).toBe(true);
    expect(validator.validate(c2).valid).toBe(true);
  });
});

describe('contract round-trip', () => {
  it('survives JSON serialization and deserialization', () => {
    const original = createContract({
      fromAgent: 'test',
      inputs: { nested: { data: [1, 2, 3] } },
      outputs: { result: 'ok' },
      decisions: [{ type: 'action', rationale: 'test' }],
      budget: { tokensUsed: 100, callsMade: 1, wallClockMs: 50 },
    });

    const json = JSON.stringify(original);
    const restored = JSON.parse(json);

    const result = validateContract(restored);
    expect(result.valid).toBe(true);

    expect(restored.id).toBe(original.id);
    expect(restored.schemaVersion).toBe(original.schemaVersion);
    expect(restored.inputs.payload).toEqual(original.inputs.payload);
    expect(restored.outputs.payload).toEqual(original.outputs.payload);
  });
});

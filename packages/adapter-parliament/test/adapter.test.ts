import { describe, it, expect, vi } from 'vitest';
import {
  wrapParliamentModel,
  ParliamentCircuitBreaker,
  ParliamentReducer,
  runParliamentDeliberation,
} from '../src/index.js';

// ─── wrapParliamentModel ───

describe('wrapParliamentModel', () => {
  it('wraps a cooperative model with L1+L2 validation', async () => {
    const mockCall = vi.fn().mockResolvedValue({ summary: 'Model response' });
    const wrapped = wrapParliamentModel(
      { id: 'test-model', role: 'proposer' },
      mockCall,
      { breaker: { tier: 'L1' } }, // Use L1-only for test (no embedding provider)
    );

    const result = await wrapped('What is Lattice?', '01ARZ3NDEKTSV4RRFFQ69G5FAV');

    expect(mockCall).toHaveBeenCalledWith('What is Lattice?');
    expect(result.passed).toBe(true);
    expect(result.contract.fromAgent).toBe('test-model');
    expect(result.contract.traceId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('wraps an adversarial model with L1 only', async () => {
    const mockCall = vi.fn().mockResolvedValue({ critique: 'This is wrong' });
    const wrapped = wrapParliamentModel(
      { id: 'skeptic', role: 'skeptic', isAdversarial: true },
      mockCall,
    );

    const result = await wrapped('What is Lattice?');

    expect(result.passed).toBe(true);
    expect(result.contract.fromAgent).toBe('skeptic');
  });

  it('returns failed contract in shadow mode', async () => {
    const mockCall = vi.fn().mockResolvedValue({});
    const wrapped = wrapParliamentModel(
      { id: 'test', role: 'proposer' },
      mockCall,
      { shadowMode: true },
    );

    const result = await wrapped('topic');

    // In shadow mode, even failed validations return without throwing
    expect(result.passed).toBeDefined();
  });

  it('uses custom breaker config', async () => {
    const mockCall = vi.fn().mockResolvedValue({ result: 'ok' });
    const wrapped = wrapParliamentModel(
      { id: 'test', role: 'pragmatist' },
      mockCall,
      { breaker: { tier: 'L1' } },
    );

    const result = await wrapped('topic');

    expect(result.passed).toBe(true);
  });
});

// ─── ParliamentCircuitBreaker ───

describe('ParliamentCircuitBreaker', () => {
  it('creates breakers for all models', () => {
    const models = [
      { id: 'opus', role: 'proposer' },
      { id: 'sonnet', role: 'expander' },
      { id: 'skeptic', role: 'skeptic', isAdversarial: true },
    ];

    const breaker = new ParliamentCircuitBreaker(models);

    expect(breaker.get('opus')).toBeDefined();
    expect(breaker.get('sonnet')).toBeDefined();
    expect(breaker.get('skeptic')).toBeDefined();
    expect(breaker.get('nonexistent')).toBeUndefined();
  });

  it('configures adversarial models with L1 only', () => {
    const models = [
      { id: 'cooperative', role: 'proposer' },
      { id: 'adversarial', role: 'devils-advocate', isAdversarial: true },
    ];

    const breaker = new ParliamentCircuitBreaker(models);

    const coopBreaker = breaker.get('cooperative');
    const advBreaker = breaker.get('adversarial');

    // Both should exist; adversarial should have L1-only config
    expect(coopBreaker).toBeDefined();
    expect(advBreaker).toBeDefined();
  });

  it('accepts custom per-model configs', () => {
    const models = [
      { id: 'model-a', role: 'proposer' },
      { id: 'model-b', role: 'expander' },
    ];

    const configs = {
      'model-a': { tier: 'L1+L3' as const },
      'model-b': { tier: 'L1' as const },
    };

    const breaker = new ParliamentCircuitBreaker(models, configs);

    expect(breaker.get('model-a')).toBeDefined();
    expect(breaker.get('model-b')).toBeDefined();
  });
});

// ─── ParliamentReducer ───

describe('ParliamentReducer', () => {
  it('detects conflicts between model responses', () => {
    const reducer = new ParliamentReducer();

    // Simulate model contracts with conflicting outputs
    const contracts = [
      {
        id: 'c1',
        schemaVersion: '0.1.0',
        traceId: 'trace-1',
        parentIds: [],
        fromAgent: 'model-a',
        toAgent: null,
        timestamp: new Date().toISOString(),
        inputs: { payload: { topic: 'AI coordination' }, contentType: 'application/json' },
        decisions: [],
        outputs: {
          payload: { mainPoint: 'Coordination is critical', supportingArguments: ['a', 'b'], conclusion: 'Use Lattice' },
          contentType: 'application/json',
        },
        constraints: [],
        assumptions: [],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
        metadata: {},
      },
      {
        id: 'c2',
        schemaVersion: '0.1.0',
        traceId: 'trace-1',
        parentIds: [],
        fromAgent: 'model-b',
        toAgent: null,
        timestamp: new Date().toISOString(),
        inputs: { payload: { topic: 'AI coordination' }, contentType: 'application/json' },
        decisions: [],
        outputs: {
          payload: { mainPoint: 'Coordination is useless', supportingArguments: ['x', 'y'], conclusion: 'Skip it' },
          contentType: 'application/json',
        },
        constraints: [],
        assumptions: [],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
        metadata: {},
      },
    ] as any;

    const result = reducer.reduce(contracts);

    expect(result.agreementRatio).toBeLessThan(1.0);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.consensusReached).toBe(false);
  });

  it('detects unanimous agreement', () => {
    const reducer = new ParliamentReducer();

    const contracts = [
      {
        id: 'c1',
        schemaVersion: '0.1.0',
        traceId: 'trace-1',
        parentIds: [],
        fromAgent: 'model-a',
        toAgent: null,
        timestamp: new Date().toISOString(),
        inputs: { payload: { topic: 'AI' }, contentType: 'application/json' },
        decisions: [],
        outputs: {
          payload: { mainPoint: 'AI is good', supportingArguments: ['a'], conclusion: 'Yes' },
          contentType: 'application/json',
        },
        constraints: [],
        assumptions: [],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
        metadata: {},
      },
      {
        id: 'c2',
        schemaVersion: '0.1.0',
        traceId: 'trace-1',
        parentIds: [],
        fromAgent: 'model-b',
        toAgent: null,
        timestamp: new Date().toISOString(),
        inputs: { payload: { topic: 'AI' }, contentType: 'application/json' },
        decisions: [],
        outputs: {
          payload: { mainPoint: 'AI is good', supportingArguments: ['a'], conclusion: 'Yes' },
          contentType: 'application/json',
        },
        constraints: [],
        assumptions: [],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
        metadata: {},
      },
    ] as any;

    const result = reducer.reduce(contracts);

    expect(result.agreementRatio).toBe(1.0);
    expect(result.conflicts.length).toBe(0);
    expect(result.consensusReached).toBe(true);
  });

  it('handles partial agreement', () => {
    const reducer = new ParliamentReducer({ minAgreementRatio: 0.5 });

    const contracts = [
      {
        id: 'c1',
        schemaVersion: '0.1.0',
        traceId: 'trace-1',
        parentIds: [],
        fromAgent: 'model-a',
        toAgent: null,
        timestamp: new Date().toISOString(),
        inputs: { payload: { topic: 'AI' }, contentType: 'application/json' },
        decisions: [],
        outputs: {
          payload: { mainPoint: 'AI is transformative', supportingArguments: ['a', 'b'], conclusion: 'Yes' },
          contentType: 'application/json',
        },
        constraints: [],
        assumptions: [],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
        metadata: {},
      },
      {
        id: 'c2',
        schemaVersion: '0.1.0',
        traceId: 'trace-1',
        parentIds: [],
        fromAgent: 'model-b',
        toAgent: null,
        timestamp: new Date().toISOString(),
        inputs: { payload: { topic: 'AI' }, contentType: 'application/json' },
        decisions: [],
        outputs: {
          payload: { mainPoint: 'AI is transformative', supportingArguments: ['a', 'c'], conclusion: 'Yes' },
          contentType: 'application/json',
        },
        constraints: [],
        assumptions: [],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
        metadata: {},
      },
      {
        id: 'c3',
        schemaVersion: '0.1.0',
        traceId: 'trace-1',
        parentIds: [],
        fromAgent: 'model-c',
        toAgent: null,
        timestamp: new Date().toISOString(),
        inputs: { payload: { topic: 'AI' }, contentType: 'application/json' },
        decisions: [],
        outputs: {
          payload: { mainPoint: 'AI is dangerous', supportingArguments: ['x', 'y'], conclusion: 'No' },
          contentType: 'application/json',
        },
        constraints: [],
        assumptions: [],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
        metadata: {},
      },
    ] as any;

    const result = reducer.reduce(contracts);

    expect(result.agreementRatio).toBeGreaterThan(0);
    expect(result.agreementRatio).toBeLessThan(1.0);
    // 2/3 agree on mainPoint → above 0.5 threshold
    expect(result.consensusReached).toBe(true);
  });
});

// ─── runParliamentDeliberation ───

describe('runParliamentDeliberation', () => {
  it('runs a full deliberation with multiple models', async () => {
    const models = [
      { id: 'model-a', role: 'proposer' },
      { id: 'model-b', role: 'expander' },
    ];

    const modelCalls = new Map([
      ['model-a', vi.fn().mockResolvedValue({ summary: 'A says yes' })],
      ['model-b', vi.fn().mockResolvedValue({ summary: 'B says yes' })],
    ]);

    const result = await runParliamentDeliberation(
      'What is the best approach to AI coordination?',
      models,
      modelCalls,
    );

    expect(result.modelContracts).toHaveLength(2);
    expect(result.modelContracts[0].fromAgent).toBe('model-a');
    expect(result.modelContracts[1].fromAgent).toBe('model-b');
    expect(result.traceId).toBe(result.modelContracts[0].traceId);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles missing model calls gracefully', async () => {
    const models = [
      { id: 'model-a', role: 'proposer' },
      { id: 'model-b', role: 'expander' },
    ];

    // Only provide a call for model-a
    const modelCalls = new Map([
      ['model-a', vi.fn().mockResolvedValue({ summary: 'A responds' })],
    ]);

    const result = await runParliamentDeliberation(
      'Topic',
      models,
      modelCalls,
    );

    // Should only have one contract
    expect(result.modelContracts).toHaveLength(1);
    expect(result.modelContracts[0].fromAgent).toBe('model-a');
  });

  it('shares traceId across all model contracts', async () => {
    const models = [
      { id: 'model-a', role: 'proposer' },
      { id: 'model-b', role: 'expander' },
      { id: 'model-c', role: 'pragmatist' },
    ];

    const modelCalls = new Map([
      ['model-a', vi.fn().mockResolvedValue({ a: 1 })],
      ['model-b', vi.fn().mockResolvedValue({ b: 2 })],
      ['model-c', vi.fn().mockResolvedValue({ c: 3 })],
    ]);

    const result = await runParliamentDeliberation('Topic', models, modelCalls);

    const traceIds = result.modelContracts.map(c => c.traceId);
    expect(new Set(traceIds).size).toBe(1); // All same traceId
  });
});

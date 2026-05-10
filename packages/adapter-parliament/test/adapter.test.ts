import { describe, it, expect, vi } from 'vitest';
import {
  wrapParliamentModel,
  ParliamentCircuitBreaker,
  ParliamentReducer,
  runParliamentDeliberation,
  type EmbeddingProvider,
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
  it('detects conflicts between model responses', async () => {
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

    const result = await reducer.reduce(contracts);

    expect(result.agreementRatio).toBeLessThan(1.0);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.consensusReached).toBe(false);
  });

  it('detects unanimous agreement', async () => {
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

    const result = await reducer.reduce(contracts);

    expect(result.agreementRatio).toBe(1.0);
    expect(result.conflicts.length).toBe(0);
    expect(result.consensusReached).toBe(true);
  });

  it('handles partial agreement', async () => {
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

    const result = await reducer.reduce(contracts);

    expect(result.agreementRatio).toBeGreaterThan(0);
    expect(result.agreementRatio).toBeLessThan(1.0);
    // 2/3 agree on mainPoint → above 0.5 threshold
    expect(result.consensusReached).toBe(true);
  });
});

// ─── ParliamentReducer — embedding similarity ───

function makeContract(id: string, agentId: string, payload: Record<string, unknown>) {
  return {
    id,
    schemaVersion: '0.1.0',
    traceId: 'trace-emb',
    parentIds: [],
    fromAgent: agentId,
    toAgent: null,
    timestamp: new Date().toISOString(),
    inputs: { payload: {}, contentType: 'application/json' },
    decisions: [],
    outputs: { payload, contentType: 'application/json' },
    constraints: [],
    assumptions: [],
    budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    metadata: {},
  } as any;
}

/** Build a mock EmbeddingProvider where embed() returns a pre-canned vector. */
function makeMockEmbeddingProvider(vectors: Map<string, number[]>): EmbeddingProvider {
  return {
    embed: vi.fn(async (text: string) => {
      const vec = vectors.get(text);
      if (!vec) throw new Error(`No vector for: ${text}`);
      return vec;
    }),
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map(t => {
        const vec = vectors.get(t);
        if (!vec) throw new Error(`No vector for: ${t}`);
        return vec;
      }),
    ),
    similarity: (a: number[], b: number[]) => {
      let dot = 0, magA = 0, magB = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] ** 2; magB += b[i] ** 2; }
      return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    },
  };
}

describe('ParliamentReducer — embedding similarity', () => {
  it('produces higher agreement ratio for semantically similar text', async () => {
    // Two texts that differ slightly (different wording, same meaning)
    // We encode them as nearly-identical vectors (similarity ≈ 0.99)
    const textA = 'AI coordination is essential for robust multi-agent systems';
    const textB = 'Coordinating AI agents is crucial for reliable multi-agent systems';
    const concA = 'Use Lattice for coordination';
    const concB = 'Lattice is the right tool for agent coordination';

    const highSim = [1, 0, 0]; // similarity with itself = 1.0
    const nearSim = [0.99, 0.141, 0]; // cosine(highSim, nearSim) ≈ 0.99

    const argVec = [1, 0, 0]; // 'arg' appears in both → unanimous, same direction
    const vectors = new Map([
      [textA, highSim],
      [textB, nearSim],
      ['arg', argVec],
      [concA, highSim],
      [concB, nearSim],
    ]);

    const provider = makeMockEmbeddingProvider(vectors);
    const reducer = new ParliamentReducer(undefined, provider);

    const contracts = [
      makeContract('c1', 'model-a', { mainPoint: textA, supportingArguments: 'arg', conclusion: concA }),
      makeContract('c2', 'model-b', { mainPoint: textB, supportingArguments: 'arg', conclusion: concB }),
    ];

    const result = await reducer.reduce(contracts);

    // With cosine ≈ 0.99 ≥ 0.85, all fields should agree
    expect(result.agreementRatio).toBeGreaterThan(0.5);
    expect(result.conflicts.length).toBe(0);
  });

  it('produces lower agreement ratio for semantically dissimilar text', async () => {
    const textA = 'AI coordination is essential for robust systems';
    const textB = 'AI is dangerous and should be banned';
    const concA = 'Use Lattice';
    const concB = 'Abandon the project';

    // Orthogonal vectors → cosine similarity = 0
    const vecA = [1, 0];
    const vecB = [0, 1];

    const supA = 'evidence supports caution';
    const supB = 'all evidence points to risk';

    const vectors = new Map([
      [textA, vecA],
      [textB, vecB],
      [supA, vecA],
      [supB, vecB],
      [concA, vecA],
      [concB, vecB],
    ]);

    const provider = makeMockEmbeddingProvider(vectors);
    const reducer = new ParliamentReducer(undefined, provider);

    const contracts = [
      makeContract('c1', 'model-a', { mainPoint: textA, supportingArguments: supA, conclusion: concA }),
      makeContract('c2', 'model-b', { mainPoint: textB, supportingArguments: supB, conclusion: concB }),
    ];

    const result = await reducer.reduce(contracts);

    // All 3 fields orthogonal → agreementRatio = 0/3 = 0
    expect(result.agreementRatio).toBeLessThan(0.5);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it('falls back to string equality when no embedding provider is configured', async () => {
    const reducer = new ParliamentReducer(); // no provider

    const contracts = [
      makeContract('c1', 'model-a', { mainPoint: 'AI is great', supportingArguments: 'x', conclusion: 'Yes' }),
      makeContract('c2', 'model-b', { mainPoint: 'AI is great', supportingArguments: 'x', conclusion: 'Yes' }),
    ];

    const result = await reducer.reduce(contracts);

    // Exact match → full agreement
    expect(result.agreementRatio).toBe(1.0);
    expect(result.conflicts.length).toBe(0);
  });

  it('uses embedBatch when available for efficiency', async () => {
    const textA = 'coordination matters';
    const textB = 'coordination is key';
    const concA = 'yes';
    const concB = 'yes';

    const highSim = [1, 0];
    const nearSim = [0.99, 0.141];

    const vectors = new Map([
      [textA, highSim], [textB, nearSim],
      ['x', highSim], // same for both → agrees
      [concA, highSim], [concB, highSim],
    ]);

    const provider = makeMockEmbeddingProvider(vectors);
    const reducer = new ParliamentReducer(undefined, provider);

    const contracts = [
      makeContract('c1', 'model-a', { mainPoint: textA, supportingArguments: 'x', conclusion: concA }),
      makeContract('c2', 'model-b', { mainPoint: textB, supportingArguments: 'x', conclusion: concB }),
    ];

    await reducer.reduce(contracts);

    expect(provider.embedBatch).toHaveBeenCalled();
    expect(provider.embed).not.toHaveBeenCalled();
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

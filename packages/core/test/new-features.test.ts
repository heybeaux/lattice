import { describe, it, expect, vi } from 'vitest';
import {
  TieredCircuitBreaker,
  ConsensusReducer,
  createContract,
  validateContract,
  CircuitBreaker,
} from '../src/index.js';
import type { EmbeddingProvider, JudgeProvider } from '../src/index.js';
import type { EmbeddingProvider, JudgeProvider } from '../src/index.js';

// ─── TieredCircuitBreaker: Auto Mode ───

describe('TieredCircuitBreaker: Auto Mode', () => {
  const mockEmbedding: EmbeddingProvider = {
    embed: async (text) => [text.length % 100, (text.length * 7) % 100, (text.length * 13) % 100],
    similarity: (a, b) => {
      const dot = a.reduce((s, v, i) => s + v * b[i], 0);
      const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
      const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
      return magA * magB > 0 ? dot / (magA * magB) : 0;
    },
  };

  it('default tier is "auto"', () => {
    const breaker = new TieredCircuitBreaker();
    // Auto mode should not throw
    expect(breaker.canAttempt()).toBe(true);
  });

  it('auto mode runs L1 only (no providers configured)', async () => {
    const breaker = new TieredCircuitBreaker(); // auto mode, no providers

    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'hello' },
      outputs: { result: 'world' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await breaker.validate(contract);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe('L1');
  });

  it('auto mode runs L1+L2 when embedding provider is set', async () => {
    const breaker = new TieredCircuitBreaker({
      l3EscalationThreshold: 0.85,
    });
    breaker.setEmbeddingProvider(mockEmbedding);

    // Create a contract where input and output are similar (same length)
    const contract = createContract({
      fromAgent: 'test',
      inputs: { text: 'hello world this is a test' },
      outputs: { summary: 'hello world this is a test' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await breaker.validate(contract);
    expect(result.passed).toBe(true);
    // L2 should run and return similarity as confidence
    expect(result.confidence).toBeDefined();
  });

  it('auto mode escalates to L3 when L2 similarity is below threshold', async () => {
    // Provider that returns moderate similarity (passes L2 threshold but below escalation)
    const modSimEmbedding: EmbeddingProvider = {
      embed: async () => [1, 0, 0],
      similarity: () => 0.75, // Above L2 threshold (0.7) but below escalation (0.85)
    };

    const mockJudge: JudgeProvider = {
      judge: async () => ({ verdict: 'pass', confidence: 0.9 }),
    };

    const breaker = new TieredCircuitBreaker({
      l2Threshold: 0.7,
      l3EscalationThreshold: 0.85,
    });
    breaker.setEmbeddingProvider(modSimEmbedding);
    breaker.setJudgeProvider(mockJudge);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'different' },
      outputs: { result: 'output' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await breaker.validate(contract);
    // L2 passes (0.75 > 0.7) but below escalation threshold (0.75 < 0.85), so L3 runs
    expect(result.passed).toBe(true);
    expect(result.tier).toBe('L3');
  });

  it('auto mode escalates to L3 when isHighRisk is set', async () => {
    const mockEmbedding: EmbeddingProvider = {
      embed: async () => [1, 0, 0],
      similarity: () => 1.0, // High similarity — wouldn't trigger L3 normally
    };

    const mockJudge: JudgeProvider = {
      judge: async () => ({ verdict: 'pass', confidence: 0.95 }),
    };

    const breaker = new TieredCircuitBreaker({
      l3EscalationThreshold: 0.85,
    });
    breaker.setEmbeddingProvider(mockEmbedding);
    breaker.setJudgeProvider(mockJudge);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'safe query' },
      outputs: { result: 'safe output' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
      metadata: { isHighRisk: true }, // Force L3 escalation
    });

    const result = await breaker.validate(contract);
    // High-risk flag forces L3 even though L2 passed
    expect(result.tier).toBe('L3');
    expect(result.confidence).toBe(0.95);
  });

  it('auto mode skips L3 when L2 similarity is above threshold', async () => {
    const mockEmbedding: EmbeddingProvider = {
      embed: async () => [1, 0, 0],
      similarity: () => 0.95, // High similarity
    };

    let judgeCalled = false;
    const mockJudge: JudgeProvider = {
      judge: async () => {
        judgeCalled = true;
        return { verdict: 'pass', confidence: 0.9 };
      },
    };

    const breaker = new TieredCircuitBreaker({
      l3EscalationThreshold: 0.85,
    });
    breaker.setEmbeddingProvider(mockEmbedding);
    breaker.setJudgeProvider(mockJudge);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'hello' },
      outputs: { result: 'hello' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await breaker.validate(contract);
    // L2 passed with high similarity, L3 should NOT run
    expect(judgeCalled).toBe(false);
    expect(result.tier).toBe('L2');
    expect(result.confidence).toBe(0.95);
  });

  it('manual mode "L1+L3" still works', async () => {
    const mockJudge: JudgeProvider = {
      judge: async () => ({ verdict: 'pass', confidence: 0.9 }),
    };

    const breaker = new TieredCircuitBreaker({
      tier: 'L1+L3',
    });
    breaker.setJudgeProvider(mockJudge);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'hello' },
      outputs: { result: 'world' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await breaker.validate(contract);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe('L3');
  });

  it('redacts secrets before sending to L2 provider', async () => {
    const seenTexts: string[] = [];
    const mockEmbedding: EmbeddingProvider = {
      embed: async (text) => {
        seenTexts.push(text);
        return [1, 0, 0];
      },
      similarity: () => 1.0,
    };

    const breaker = new TieredCircuitBreaker({ tier: 'L1+L2' });
    breaker.setEmbeddingProvider(mockEmbedding);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'hello', apiKey: 'sk-live-secret-12345' },
      outputs: { result: 'world', password: 'hunter2' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await breaker.validate(contract);
    expect(result.passed).toBe(true);

    // Verify secrets were redacted in provider calls
    for (const text of seenTexts) {
      expect(text).not.toContain('sk-live-secret-12345');
      expect(text).not.toContain('hunter2');
      expect(text).toContain('[REDACTED]');
    }
  });

  it('redacts secrets before sending to L3 provider', async () => {
    const seenTexts: string[] = [];
    const mockJudge: JudgeProvider = {
      judge: async (task, output, context) => {
        seenTexts.push(task, output);
        return { verdict: 'pass', confidence: 0.95 };
      },
    };

    const breaker = new TieredCircuitBreaker({ tier: 'L1+L3' });
    breaker.setJudgeProvider(mockJudge);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { apiKey: 'sk-prod-secret' },
      outputs: { secretKey: 'ghp_abc123' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await breaker.validate(contract);
    expect(result.passed).toBe(true);

    // Verify secrets were redacted from inputs and outputs sent to judge
    expect(seenTexts[0]).not.toContain('sk-prod-secret');
    expect(seenTexts[0]).toContain('[REDACTED]');
    expect(seenTexts[1]).not.toContain('ghp_abc123');
    expect(seenTexts[1]).toContain('[REDACTED]');
  });
});

// ─── ConsensusReducer ───

describe('ConsensusReducer', () => {
  const makeContract = (fromAgent: string, output: unknown) =>
    createContract({
      fromAgent,
      inputs: {},
      outputs: output,
      budget: { tokensUsed: 100, callsMade: 1, wallClockMs: 50 },
    });

  it('returns single output when only one contract', () => {
    const reducer = new ConsensusReducer();
    const contract = makeContract('agent-1', { summary: 'hello', score: 90 });

    const result = reducer.reduce([contract as any]);
    expect(result.output).toEqual({ summary: 'hello', score: 90 });
    expect(result.consensus).toBe(true);
    expect(result.agreementRatio).toBe(1.0);
    expect(result.conflicts).toEqual([]);
  });

  it('detects unanimous agreement', () => {
    const reducer = new ConsensusReducer();
    const c1 = makeContract('agent-1', { summary: 'hello', score: 90 });
    const c2 = makeContract('agent-2', { summary: 'hello', score: 90 });
    const c3 = makeContract('agent-3', { summary: 'hello', score: 90 });

    const result = reducer.reduce([c1, c2, c3] as any);
    expect(result.output).toEqual({ summary: 'hello', score: 90 });
    expect(result.consensus).toBe(true);
    expect(result.agreementRatio).toBe(1.0);
    expect(result.conflicts).toEqual([]);
  });

  it('resolves conflicts via majority vote', () => {
    const reducer = new ConsensusReducer();
    const c1 = makeContract('agent-1', { summary: 'hello', score: 90 });
    const c2 = makeContract('agent-2', { summary: 'hello', score: 90 });
    const c3 = makeContract('agent-3', { summary: 'different', score: 50 });

    const result = reducer.reduce([c1, c2, c3] as any);
    expect(result.output.summary).toBe('hello');
    expect(result.output.score).toBe(90);
    expect(result.conflicts.length).toBe(0); // 2/3 is majority, above default 0.6
    expect(result.consensus).toBe(true);
    expect(result.agreementRatio).toBe(1.0);
  });

  it('detects unresolved conflicts when no majority', () => {
    const reducer = new ConsensusReducer({
      minAgreementRatio: 0.8,
    });
    const c1 = makeContract('agent-1', { summary: 'hello' });
    const c2 = makeContract('agent-2', { summary: 'world' });
    const c3 = makeContract('agent-3', { summary: 'different' });

    const result = reducer.reduce([c1, c2, c3] as any);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].field).toBe('summary');
    expect(result.consensus).toBe(false);
  });

  it('supports first-agent strategy', () => {
    const reducer = new ConsensusReducer({
      conflictStrategy: 'first',
    });
    const c1 = makeContract('agent-1', { summary: 'hello' });
    const c2 = makeContract('agent-2', { summary: 'world' });

    const result = reducer.reduce([c1, c2] as any);
    expect(result.output.summary).toBe('hello');
    expect(result.conflicts.length).toBe(1); // Not resolved (first strategy always flags)
  });

  it('creates reduced contract with lineage', () => {
    const reducer = new ConsensusReducer();
    const c1 = makeContract('agent-1', { summary: 'hello' });
    const c2 = makeContract('agent-2', { summary: 'hello' });

    const reduceResult = reducer.reduce([c1, c2] as any);
    const reducedContract = reducer.createReducedContract(reduceResult, [c1, c2] as any);

    expect(reducedContract.fromAgent).toBe('consensus-reducer');
    expect(reducedContract.parentIds).toEqual([c1.id, c2.id]);
    expect(reducedContract.outputs.payload).toEqual({ summary: 'hello' });
    expect(reducedContract.metadata.reducedFrom).toBe(2);
    expect(reducedContract.metadata.agreementRatio).toBe(1.0);
    expect(reducedContract.metadata.conflictCount).toBe(0);
  });

  it('flags high-risk when no consensus', () => {
    const reducer = new ConsensusReducer();
    const c1 = makeContract('agent-1', { summary: 'hello' });
    const c2 = makeContract('agent-2', { summary: 'world' });
    const c3 = makeContract('agent-3', { summary: 'different' });

    const reduceResult = reducer.reduce([c1, c2, c3] as any);
    const reducedContract = reducer.createReducedContract(reduceResult, [c1, c2, c3] as any);

    expect(reducedContract.metadata.isHighRisk).toBe(true);
    expect(reducedContract.assumptions.length).toBe(1);
    expect(reducedContract.assumptions[0].riskLevel).toBe('high');
  });

  it('includes individual outputs when configured', () => {
    const reducer = new ConsensusReducer({
      includeIndividualOutputs: true,
    });
    const c1 = makeContract('agent-1', { summary: 'hello' });
    const c2 = makeContract('agent-2', { summary: 'world' });

    const reduceResult = reducer.reduce([c1, c2] as any);
    const reducedContract = reducer.createReducedContract(reduceResult, [c1, c2] as any);

    expect(reducedContract.metadata.individualOutputs).toBeDefined();
    expect(reducedContract.metadata.individualOutputs).toHaveLength(2);
  });

  it('handles mismatched field sets', () => {
    const reducer = new ConsensusReducer();
    const c1 = makeContract('agent-1', { summary: 'hello', extra: 'field1' });
    const c2 = makeContract('agent-2', { summary: 'hello' }); // missing extra field

    const result = reducer.reduce([c1, c2] as any);
    // Only common fields are reduced
    expect(result.output).toHaveProperty('summary');
  });

  it('supports explicit field selection', () => {
    const reducer = new ConsensusReducer({
      consensusFields: ['summary'],
    });
    const c1 = makeContract('agent-1', { summary: 'hello', score: 90 });
    const c2 = makeContract('agent-2', { summary: 'hello', score: 50 });

    const result = reducer.reduce([c1, c2] as any);
    expect(result.output).toHaveProperty('summary');
    // score is not in consensusFields, so it's not included
    expect(result.output).not.toHaveProperty('score');
  });
});

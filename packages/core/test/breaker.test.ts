import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CircuitBreaker,
  TieredCircuitBreaker,
  wrapAgent,
  HandoffFailure,
  createContract,
} from '../src/index.js';
import type { JudgeProvider, EmbeddingProvider } from '../src/index.js';

// ─── CircuitBreaker State Machine ───

describe('CircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe('closed');
    expect(cb.canAttempt()).toBe(true);
  });

  it('transitions to open after consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('closed'); // not yet at threshold

    cb.recordFailure(); // third failure
    expect(cb.state).toBe('open');
    expect(cb.canAttempt()).toBe(false);
  });

  it('resets consecutive failures on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // resets counter
    cb.recordFailure();

    expect(cb.state).toBe('closed'); // only 1 consecutive failure
  });

  it('transitions to half-open after recovery timeout', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 1000,
    });

    cb.recordFailure(); // opens circuit
    expect(cb.state).toBe('open');

    vi.advanceTimersByTime(500);
    expect(cb.state).toBe('open');

    vi.advanceTimersByTime(500); // total 1000ms
    expect(cb.state).toBe('half-open');
    expect(cb.canAttempt()).toBe(true);

    vi.useRealTimers();
  });

  it('transitions half-open → closed on success', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 100,
    });

    cb.recordFailure();
    vi.advanceTimersByTime(100);
    expect(cb.state).toBe('half-open');

    cb.recordSuccess();
    expect(cb.state).toBe('closed');

    vi.useRealTimers();
  });

  it('transitions half-open → open on failure', () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 100,
    });

    cb.recordFailure();
    vi.advanceTimersByTime(100);
    expect(cb.state).toBe('half-open');

    cb.recordFailure();
    expect(cb.state).toBe('open');

    vi.useRealTimers();
  });

  it('tracks metrics correctly', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure(); // opens

    const m = cb.metrics;
    expect(m.totalAttempts).toBe(3);
    expect(m.totalSuccesses).toBe(1);
    expect(m.totalFailures).toBe(2);
    expect(m.state).toBe('open');
    expect(m.timesOpened).toBe(1);
  });

  it('resets to closed state', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.state).toBe('open');

    cb.reset();
    expect(cb.state).toBe('closed');
    expect(cb.canAttempt()).toBe(true);
  });
});

// ─── TieredCircuitBreaker ───

describe('TieredCircuitBreaker', () => {
  it('L1-only validates a correct contract', async () => {
    const cb = new TieredCircuitBreaker({ tier: 'L1' });
    const contract = createContract({
      fromAgent: 'test',
      inputs: { x: 1 },
      outputs: { y: 2 },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await cb.validate(contract);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe('L1');
  });

  it('L1 rejects an invalid contract', async () => {
    const cb = new TieredCircuitBreaker({ tier: 'L1' });
    const bad = { not: 'a contract' };

    // Validate via unknown to test schema rejection
    const result = await cb.validate(bad as any);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe('L1');
    expect(result.reason).toContain('Schema validation failed');
  });

  it('L2 fails without EmbeddingProvider', async () => {
    const cb = new TieredCircuitBreaker({ tier: 'L1+L2' });
    const contract = createContract({
      fromAgent: 'test',
      inputs: { x: 1 },
      outputs: { y: 2 },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await cb.validate(contract);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe('L2');
    expect(result.reason).toContain('EmbeddingProvider');
  });

  it('L2 passes with EmbeddingProvider', async () => {
    const mockProvider: EmbeddingProvider = {
      embed: async (text) => [1, 0, 0], // same vector for everything
      similarity: () => 1.0, // perfect similarity
    };

    const cb = new TieredCircuitBreaker({ tier: 'L1+L2' });
    cb.setEmbeddingProvider(mockProvider);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { x: 1 },
      outputs: { y: 2 },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await cb.validate(contract);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe('L2');
  });

  it('L2 fails when similarity is below threshold', async () => {
    const mockProvider: EmbeddingProvider = {
      embed: async () => [1, 0, 0],
      similarity: () => 0.3, // below default 0.7
    };

    const cb = new TieredCircuitBreaker({ tier: 'L1+L2' });
    cb.setEmbeddingProvider(mockProvider);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { x: 1 },
      outputs: { y: 2 },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await cb.validate(contract);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe('L2');
    expect(result.reason).toContain('below threshold');
  });

  it('L3 fails without JudgeProvider', async () => {
    const cb = new TieredCircuitBreaker({ tier: 'L1+L3' });
    const contract = createContract({
      fromAgent: 'test',
      inputs: { x: 1 },
      outputs: { y: 2 },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await cb.validate(contract);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe('L3');
    expect(result.reason).toContain('JudgeProvider');
  });

  it('L3 passes with JudgeProvider', async () => {
    const mockJudge: JudgeProvider = {
      judge: async () => ({ verdict: 'pass', confidence: 0.95 }),
    };

    const cb = new TieredCircuitBreaker({ tier: 'L1+L3' });
    cb.setJudgeProvider(mockJudge);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { x: 1 },
      outputs: { y: 2 },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await cb.validate(contract);
    expect(result.passed).toBe(true);
    expect(result.tier).toBe('L3');
    expect(result.confidence).toBe(0.95);
  });

  it('L3 fails on uncertain verdict below threshold', async () => {
    const mockJudge: JudgeProvider = {
      judge: async () => ({ verdict: 'uncertain', confidence: 0.5 }),
    };

    const cb = new TieredCircuitBreaker({ tier: 'L1+L3' });
    cb.setJudgeProvider(mockJudge);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { x: 1 },
      outputs: { y: 2 },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });

    const result = await cb.validate(contract);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe('L3');
    expect(result.confidence).toBe(0.5);
  });

  it('circuit opens after consecutive failures', async () => {
    const cb = new TieredCircuitBreaker({
      tier: 'L1',
      failureThreshold: 2,
    });

    const bad = { not: 'a contract' };
    await cb.validate(bad as any); // fail 1
    await cb.validate(bad as any); // fail 2 → opens

    expect(cb.state).toBe('open');
  });

  it('returns immediately when circuit is open', async () => {
    const cb = new TieredCircuitBreaker({
      tier: 'L1',
      failureThreshold: 1,
    });

    const bad = { not: 'a contract' };
    await cb.validate(bad as any); // opens circuit

    const result = await cb.validate(bad as any);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('Circuit breaker is open');
  });
});

// ─── wrapAgent ───

describe('wrapAgent', () => {
  it('wraps a sync agent function', async () => {
    const agent = wrapAgent(
      (input: { n: number }) => ({ result: input.n * 2 }),
      { id: 'doubler' },
    );

    const contract = await agent({ n: 5 });
    expect(contract.fromAgent).toBe('doubler');
    expect(contract.outputs.payload.result).toBe(10);
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it('wraps an async agent function', async () => {
    const agent = wrapAgent(
      async (input: { msg: string }) => ({ echoed: input.msg.toUpperCase() }),
      { id: 'shouter' },
    );

    const contract = await agent({ msg: 'hello' });
    expect(contract.outputs.payload.echoed).toBe('HELLO');
  });

  it('propagates traceId', async () => {
    const agent = wrapAgent(
      (input: unknown) => ({ ok: true }),
      { id: 'test' },
    );

    const traceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const contract = await agent({}, traceId);
    expect(contract.traceId).toBe(traceId);
  });

  it('throws HandoffFailure on L3 rejection (no JudgeProvider)', async () => {
    // wrapAgent with L1+L3 but no JudgeProvider → L3 fails → abort
    const agent = wrapAgent(
      (input: unknown) => ({ ok: true }),
      {
        id: 'test',
        breaker: { tier: 'L1+L3', onReject: 'abort' },
      },
    );

    await expect(agent({})).rejects.toThrow(HandoffFailure);
  });

  it('throws HandoffFailure with validation details', async () => {
    const agent = wrapAgent(
      (input: unknown) => ({ ok: true }),
      {
        id: 'test',
        breaker: { tier: 'L1+L3', onReject: 'abort' },
      },
    );

    try {
      await agent({});
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HandoffFailure);
      const err = e as HandoffFailure;
      expect(err.validation.passed).toBe(false);
      expect(err.validation.tier).toBe('L3');
      expect(err.contract.fromAgent).toBe('test');
    }
  });

  it('degrade mode returns flagged contract on rejection', async () => {
    const agent = wrapAgent(
      (input: unknown) => ({ ok: true }),
      {
        id: 'test',
        breaker: { tier: 'L1+L3', onReject: 'degrade' },
      },
    );

    const contract = await agent({});
    expect(contract.metadata.validationStatus).toBe('rejected');
    expect(contract.metadata.validationTier).toBe('L3');
  });

  it('throws HandoffFailure when agent throws', async () => {
    const agent = wrapAgent(
      () => {
        throw new Error('something broke');
      },
      { id: 'broken' },
    );

    await expect(agent({})).rejects.toThrow(HandoffFailure);
  });

  it('tracks wall clock time in budget', async () => {
    const agent = wrapAgent(
      async (input: unknown) => {
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true };
      },
      { id: 'slow', breaker: { tier: 'L1' } },
    );

    const contract = await agent({});
    expect(contract.budget.wallClockMs).toBeGreaterThanOrEqual(45);
  });
});

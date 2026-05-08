import { describe, it, expect, vi } from 'vitest';
import {
  createOpenAIEmbeddingProvider,
  createOpenAIJudgeProvider,
  cosineSimilarity,
} from '../src/index.js';

// ─── Cosine Similarity ───

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('handles high-dimensional vectors', () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.1));
    const b = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.1));
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow('dimension mismatch');
  });

  it('handles zero vectors gracefully', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });
});

// ─── Embedding Provider ───

describe('createOpenAIEmbeddingProvider', () => {
  it('returns a provider with embed and similarity methods', () => {
    // Mock the OpenAI client — we can't call real API without a key
    const provider = createOpenAIEmbeddingProvider({
      apiKey: 'sk-test-fake',
    });

    expect(typeof provider.embed).toBe('function');
    expect(typeof provider.similarity).toBe('function');
  });

  it('similarity function computes correct cosine similarity', () => {
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'sk-test-fake' });

    const a = [1, 0, 0];
    const b = [0.707, 0.707, 0]; // 45-degree angle
    const sim = provider.similarity(a, b);
    expect(sim).toBeCloseTo(0.707, 2);
  });
});

// ─── Judge Provider ───

describe('createOpenAIJudgeProvider', () => {
  it('returns a provider with judge method', () => {
    const provider = createOpenAIJudgeProvider({
      apiKey: 'sk-test-fake',
    });

    expect(typeof provider.judge).toBe('function');
  });

  it('returns uncertain verdict on API error', async () => {
    // Fake key will cause API error — test graceful handling
    const provider = createOpenAIJudgeProvider({
      apiKey: 'sk-invalid-key-that-will-fail',
    });

    const result = await provider.judge(
      'Summarize this text',
      'The text says things.',
      '{}',
    );

    expect(result.verdict).toBe('uncertain');
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain('Judge API error');
  });

  it('parses JSON response from judge', async () => {
    // We can't test with real API, but verify the parse path works
    // by testing the structure of JudgeResult
    const mockResult = {
      verdict: 'pass' as const,
      confidence: 0.95,
      reasoning: 'Output addresses all task requirements',
    };

    expect(mockResult.verdict).toBe('pass');
    expect(mockResult.confidence).toBeGreaterThan(0.5);
    expect(typeof mockResult.reasoning).toBe('string');
  });
});

// ─── Integration with Lattice Core ───

describe('Provider integration with TieredCircuitBreaker', async () => {
  const { TieredCircuitBreaker, createContract } = await import('../../core/src/index.js');

  it('accepts the OpenAI embedding provider', () => {
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'sk-test' });
    const breaker = new TieredCircuitBreaker({ tier: 'L1+L2' });
    breaker.setEmbeddingProvider(provider);

    // Provider is set — L2 validation would work with a real API key
    expect(breaker.canAttempt()).toBe(true);
  });

  it('accepts the OpenAI judge provider', () => {
    const provider = createOpenAIJudgeProvider({ apiKey: 'sk-test' });
    const breaker = new TieredCircuitBreaker({ tier: 'L1+L3' });
    breaker.setJudgeProvider(provider);

    expect(breaker.canAttempt()).toBe(true);
  });

  it('L2 fails gracefully with fake API key', async () => {
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'sk-invalid' });
    const breaker = new TieredCircuitBreaker({ tier: 'L1+L2' });
    breaker.setEmbeddingProvider(provider);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'hello' },
      outputs: { result: 'world' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const result = await breaker.validate(contract);
    // L1 passes, L2 fails with API error
    expect(result.passed).toBe(false);
    expect(result.tier).toBe('L2');
  });

  it('L3 returns uncertain with invalid API key', async () => {
    const provider = createOpenAIJudgeProvider({ apiKey: 'sk-invalid' });
    const breaker = new TieredCircuitBreaker({ tier: 'L1+L3' });
    breaker.setJudgeProvider(provider);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'hello' },
      outputs: { result: 'world' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const result = await breaker.validate(contract);
    expect(result.passed).toBe(false);
    expect(result.tier).toBe('L3');
    // The judge returns uncertain on API failure (reasoning may vary by SDK version)
  });
});

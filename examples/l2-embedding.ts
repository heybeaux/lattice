#!/usr/bin/env node
/**
 * L2 Embedding Example
 *
 * Demonstrates TieredCircuitBreaker with an OpenAI embedding provider for
 * semantic consistency (L2) validation. L2 checks that the agent's output
 * is semantically related to its input by comparing embedding vectors.
 *
 * Requirements:
 *   OPENAI_API_KEY environment variable (real OpenAI embeddings)
 *
 * Run: OPENAI_API_KEY=sk-... npx tsx examples/l2-embedding.ts
 *
 * Without an API key the example will use a mock provider to demonstrate
 * the same code paths without making real API calls.
 */

import {
  TieredCircuitBreaker,
  createContract,
  type EmbeddingProvider,
} from '../packages/core/src/index.js';

// ─── Embedding provider ───────────────────────────────────────────────────────

let embeddingProvider: EmbeddingProvider;

if (process.env.OPENAI_API_KEY) {
  // Real OpenAI embeddings (text-embedding-3-small, 1536 dims)
  // Uses LRU cache (1024 entries) + token-bucket rate limiter (60 req/min)
  const { createOpenAIEmbeddingProvider } = await import(
    '../packages/provider-openai/src/index.js'
  );
  embeddingProvider = createOpenAIEmbeddingProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-small',
    cacheSize: 1024,
    timeoutMs: 10_000,
    rateLimit: { ratePerInterval: 60, intervalMs: 60_000 },
  });
  console.log('Using real OpenAI embeddings.\n');
} else {
  // Mock provider: returns fixed vectors so we can run without an API key.
  // similarity(a, b) = cosine similarity of the two vectors.
  const { cosineSimilarity } = await import('../packages/core/src/index.js');

  const RELATED_VEC: number[] = Array.from({ length: 8 }, (_, i) => (i + 1) / 8);
  const UNRELATED_VEC: number[] = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 1 : -1));

  embeddingProvider = {
    async embed(text: string): Promise<number[]> {
      // Simulate: "research" → related to "AI coordination"  (high similarity)
      //           "cats"    → unrelated to "AI coordination" (low similarity)
      return text.includes('research') || text.includes('agent')
        ? RELATED_VEC
        : UNRELATED_VEC;
    },
    similarity: cosineSimilarity,
  };
  console.log('OPENAI_API_KEY not set — using mock embedding provider.\n');
}

// ─── Circuit breaker setup ────────────────────────────────────────────────────

const breaker = new TieredCircuitBreaker({
  tier: 'L1+L2',
  l2Threshold: 0.7,          // cosine similarity must be >= 0.7
  l3EscalationThreshold: 0.85, // below this, L3 would run in 'auto' mode
  onReject: 'abort',
});

breaker.setEmbeddingProvider(embeddingProvider);

console.log('=== L2 Embedding Validation Demo ===\n');
console.log('Config: tier=L1+L2, l2Threshold=0.7\n');

// ─── Scenario 1: Semantically related output (should pass) ───────────────────

console.log('--- Scenario 1: Semantically consistent output ---');

const goodContract = createContract({
  fromAgent: 'researcher',
  inputs: { query: 'What is multi-agent AI coordination?' },
  outputs: {
    summary: 'Multi-agent AI coordination involves protocols for agent handoffs.',
    confidence: 0.9,
  },
  budget: { tokensUsed: 200, callsMade: 1, wallClockMs: 800 },
});

const goodResult = await breaker.validate(goodContract);
console.log(`  L1 + L2 validation passed: ${goodResult.passed}`);
console.log(`  Tier reached:              ${goodResult.tier}`);
console.log(`  L2 confidence:             ${goodResult.confidence?.toFixed(3) ?? 'n/a'}`);
console.log(`  Duration:                  ${goodResult.durationMs}ms\n`);

// ─── Scenario 2: Semantically unrelated output (should fail L2) ──────────────

console.log('--- Scenario 2: Semantically inconsistent output (off-topic) ---');

const badContract = createContract({
  fromAgent: 'researcher',
  inputs: { query: 'What is multi-agent AI coordination?' },
  outputs: {
    // The mock embedding provider will return a low-similarity vector
    // for this "cats" output vs the "agent"-containing input above
    summary: 'Cats are popular pets known for their independence.',
  },
  budget: { tokensUsed: 50, callsMade: 1, wallClockMs: 200 },
});

const badResult = await breaker.validate(badContract);
console.log(`  L1 + L2 validation passed: ${badResult.passed}`);
console.log(`  Tier reached:              ${badResult.tier}`);
console.log(`  L2 confidence:             ${badResult.confidence?.toFixed(3) ?? 'n/a'}`);
console.log(`  Failure reason:            ${badResult.reason ?? 'none'}`);
console.log(`  Duration:                  ${badResult.durationMs}ms\n`);

// ─── Scenario 3: Degraded mode — L2 timeout treated as pass ──────────────────

console.log('--- Scenario 3: Degrade mode (provider failure → pass-through) ---');

const timeoutSimProvider: EmbeddingProvider = {
  async embed(): Promise<number[]> {
    // Simulate a provider that always times out
    await new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Network timeout')), 10),
    );
    return [];
  },
  similarity() {
    return 0;
  },
};

const degradeBreaker = new TieredCircuitBreaker({
  tier: 'L1+L2',
  onReject: 'degrade',  // <-- key: provider failures are treated as pass-through
});
degradeBreaker.setEmbeddingProvider(timeoutSimProvider);

const degradeContract = createContract({
  fromAgent: 'researcher',
  inputs: { query: 'test query' },
  outputs: { result: 'test result' },
  budget: { tokensUsed: 10, callsMade: 1, wallClockMs: 50 },
});

const degradeResult = await degradeBreaker.validate(degradeContract);
console.log(`  Validation passed:    ${degradeResult.passed}  (degrade mode)`);
console.log(`  providerFailure flag: ${degradeResult.providerFailure ?? false}`);
console.log(`  Tier:                 ${degradeResult.tier}\n`);

// ─── Metrics ─────────────────────────────────────────────────────────────────

console.log('--- Circuit breaker metrics ---');
const m = breaker.metrics;
console.log(`  state:          ${m.state}`);
console.log(`  totalAttempts:  ${m.totalAttempts}`);
console.log(`  totalSuccesses: ${m.totalSuccesses}`);
console.log(`  totalFailures:  ${m.totalFailures}`);

#!/usr/bin/env node
/**
 * Error Boundaries Example
 *
 * Demonstrates:
 * 1. withTimeout — race an async call against a deadline
 * 2. withRateLimit — retry on 429 with exponential backoff
 * 3. Typed provider errors: ProviderTimeoutError, ProviderRateLimitError
 * 4. onReject: 'degrade' — pipeline continues when a provider fails
 *
 * Run: npx tsx examples/error-boundaries.ts
 */

import {
  withTimeout,
  withRateLimit,
  ProviderTimeoutError,
  ProviderRateLimitError,
  MalformedProviderResponseError,
  isProviderError,
  TieredCircuitBreaker,
  createContract,
  pipeline,
  type EmbeddingProvider,
} from '../packages/core/src/index.js';

console.log('=== Error Boundaries Demo ===\n');

// ─── 1. withTimeout ───────────────────────────────────────────────────────────

console.log('--- 1. withTimeout ---\n');

/** Simulates a slow provider that takes `delayMs` to respond */
async function slowProvider(delayMs: number): Promise<string> {
  return new Promise<string>((resolve) => setTimeout(() => resolve('ok'), delayMs));
}

// Should succeed — response arrives before the deadline
try {
  const result = await withTimeout(() => slowProvider(50), 200, 'fast-provider');
  console.log(`  OK:  Fast call returned "${result}" within 200ms timeout`);
} catch (err) {
  console.log(`  UNEXPECTED error: ${(err as Error).message}`);
}

// Should fail — response arrives after the deadline
try {
  await withTimeout(() => slowProvider(500), 100, 'slow-provider');
  console.log('  UNEXPECTED: call should have timed out');
} catch (err) {
  if (err instanceof ProviderTimeoutError) {
    console.log(`  TIMEOUT: ${err.message}`);
    console.log(`    provider:  ${err.provider}`);
    console.log(`    timeoutMs: ${err.timeoutMs}`);
  }
}

console.log();

// ─── 2. withRateLimit ────────────────────────────────────────────────────────

console.log('--- 2. withRateLimit ---\n');

let callCount = 0;

/** Simulates a provider that fails with 429 for the first two calls */
async function rateLimitedProvider(): Promise<string> {
  callCount++;
  if (callCount <= 2) {
    const err = new Error('Too Many Requests') as Error & { status: number };
    err.status = 429;
    throw err;
  }
  return `success after ${callCount} attempts`;
}

callCount = 0;
try {
  const result = await withRateLimit(
    () => rateLimitedProvider(),
    'rate-limited-provider',
    3,    // maxRetries
    10,   // baseDelayMs (short for demo)
  );
  console.log(`  OK:  ${result}`);
} catch (err) {
  console.log(`  UNEXPECTED error: ${(err as Error).message}`);
}

// Show case where retries are exhausted
callCount = 0;
try {
  await withRateLimit(
    () => rateLimitedProvider(),
    'rate-limited-provider',
    1,   // maxRetries — only 1 retry, but provider needs 2
    10,
  );
  console.log('  UNEXPECTED: should have thrown ProviderRateLimitError');
} catch (err) {
  if (err instanceof ProviderRateLimitError) {
    console.log(`  RATE LIMIT: ${err.message}`);
    console.log(`    provider:      ${err.provider}`);
    console.log(`    retryAfterMs:  ${err.retryAfterMs ?? 'not provided'}`);
  }
}

console.log();

// ─── 3. isProviderError type guard ───────────────────────────────────────────

console.log('--- 3. isProviderError type guard ---\n');

const errors: unknown[] = [
  new ProviderTimeoutError('openai', 5000),
  new ProviderRateLimitError('anthropic', 30_000),
  new MalformedProviderResponseError('cohere', '{"unexpected":"shape"}'),
  new Error('Generic error — not a provider error'),
];

for (const err of errors) {
  if (isProviderError(err)) {
    console.log(`  Provider error: [${(err as Error).name}] ${(err as Error).message}`);
  } else {
    console.log(`  Other error:    ${(err as Error).message}`);
  }
}

console.log();

// ─── 4. onReject: 'degrade' with TieredCircuitBreaker ────────────────────────

console.log('--- 4. Graceful degradation (onReject: degrade) ---\n');

/** A mock embedding provider that always throws ProviderTimeoutError */
const unreliableProvider: EmbeddingProvider = {
  async embed(): Promise<number[]> {
    throw new ProviderTimeoutError('mock-embedder', 100);
  },
  similarity(): number {
    return 0;
  },
};

// With onReject: 'abort' (default), a provider failure causes the validation
// to fail and the circuit breaker records a failure.
const strictBreaker = new TieredCircuitBreaker({
  tier: 'L1+L2',
  onReject: 'abort',
});
strictBreaker.setEmbeddingProvider(unreliableProvider);

const contract = createContract({
  fromAgent: 'agent',
  inputs: { task: 'summarize' },
  outputs: { result: 'Here is the summary.' },
  budget: { tokensUsed: 100, callsMade: 1, wallClockMs: 200 },
});

const strictResult = await strictBreaker.validate(contract);
console.log('  With onReject: abort (default):');
console.log(`    passed:         ${strictResult.passed}  (provider error → reject)`);
console.log(`    tier:           ${strictResult.tier}`);
console.log(`    reason:         ${strictResult.reason}\n`);

// With onReject: 'degrade', a known provider error is treated as a pass-through.
// The result is flagged with providerFailure: true.
const degradeBreaker = new TieredCircuitBreaker({
  tier: 'L1+L2',
  onReject: 'degrade',
});
degradeBreaker.setEmbeddingProvider(unreliableProvider);

const degradeResult = await degradeBreaker.validate(contract);
console.log('  With onReject: degrade:');
console.log(`    passed:         ${degradeResult.passed}  (provider error → pass-through)`);
console.log(`    providerFailure: ${degradeResult.providerFailure ?? false}`);
console.log(`    tier:           ${degradeResult.tier}\n`);

// ─── 5. Degrade mode in a pipeline ───────────────────────────────────────────

console.log('--- 5. Degrade mode in a pipeline ---\n');

const p = pipeline()
  .agent(
    'risky-agent',
    async (input: { query: string }) => {
      return { answer: `Answer to: ${input.query}`, confidence: 0.6 };
    },
    { breaker: { tier: 'L1' } },
  )
  .agent(
    'safe-agent',
    async (input: { answer: string; confidence: number }) => {
      return { final: input.answer, flagged: input.confidence < 0.7 };
    },
    { breaker: { tier: 'L1' } },
  )
  .onReject('degrade')
  .build();

const pResult = await p.execute({ query: 'What is multi-agent coordination?' });

console.log(`  Pipeline completed: ${(pResult.output as { final: string; flagged: boolean }).final}`);
console.log(`  hadRejected:        ${pResult.hadRejected}`);
console.log(`  contracts:          ${pResult.contracts.length}`);
console.log(
  '\nWith degrade mode, the pipeline always completes.',
  'Rejected contracts are flagged in pResult.hadRejected.',
);

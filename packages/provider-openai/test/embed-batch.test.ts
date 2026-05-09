/**
 * Issue #19 (H12) — embed batching, LRU cache, and rate limiting.
 *
 * The L2 path on TieredCircuitBreaker fires two embeddings per validation.
 * Without batching/caching/throttling, a busy pipeline would issue 2N
 * outbound calls per N validations and trip provider rate limits. These
 * tests pin the optimizations:
 *
 *   (a) embedBatch packs N inputs into ONE provider call.
 *   (b) cache returns hits without calling the provider.
 *   (c) rate limiter throttles calls when the bucket is empty.
 */
import { describe, it, expect, vi } from 'vitest';
import { TokenBucket } from '@heybeaux/lattice-core';
import { createOpenAIEmbeddingProvider } from '../src/index.js';

/**
 * Build a fake OpenAI client surface that records every call to
 * `embeddings.create` and returns deterministic-but-distinct vectors. The
 * provider only reads `client.embeddings.create`, so we can pass a stub
 * that satisfies just that shape.
 */
function makeFakeClient() {
  const create = vi.fn(async (req: { input: string | string[] }) => {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      data: inputs.map((s, i) => ({
        // 4-dim vector tagged with input length so tests can assert
        // they got the right vector back.
        embedding: [s.length, i, 0.1, 0.2],
        index: i,
        object: 'embedding' as const,
      })),
      model: 'fake',
      object: 'list' as const,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  });

  // Cast through unknown — we are intentionally constructing a stub that
  // satisfies the narrow `Pick<OpenAI, 'embeddings'>` shape the provider
  // accepts via its `client` injection point.
  return {
    client: { embeddings: { create } } as unknown as Parameters<
      typeof createOpenAIEmbeddingProvider
    >[0] extends { client?: infer C }
      ? NonNullable<C>
      : never,
    create,
  };
}

describe('createOpenAIEmbeddingProvider — embedBatch (#19)', () => {
  it('issues a SINGLE provider call for two inputs', async () => {
    const { client, create } = makeFakeClient();
    const provider = createOpenAIEmbeddingProvider({
      client,
      rateLimit: false, // remove timing variability from this assertion
    });

    expect(typeof provider.embedBatch).toBe('function');
    const vecs = await provider.embedBatch!(['alpha', 'beta-longer']);

    expect(create).toHaveBeenCalledTimes(1);
    // The batched call passes the array form, not two separate strings.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ input: ['alpha', 'beta-longer'] }),
    );
    expect(vecs).toHaveLength(2);
    // The fake encodes input length in the first dim — proves order is
    // preserved (alpha=5, beta-longer=11).
    expect(vecs[0][0]).toBe(5);
    expect(vecs[1][0]).toBe(11);
  });

  it('serves cached entries on repeat batch calls without hitting the provider', async () => {
    const { client, create } = makeFakeClient();
    const provider = createOpenAIEmbeddingProvider({
      client,
      rateLimit: false,
    });

    // First call: both inputs miss → one provider call.
    await provider.embedBatch!(['x', 'y']);
    expect(create).toHaveBeenCalledTimes(1);

    // Second call: identical inputs → both hit → ZERO additional calls.
    const second = await provider.embedBatch!(['x', 'y']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(second[0][0]).toBe(1); // 'x'.length === 1
    expect(second[1][0]).toBe(1); // 'y'.length === 1
  });

  it('mixes cache hits and misses in a single batched call', async () => {
    const { client, create } = makeFakeClient();
    const provider = createOpenAIEmbeddingProvider({
      client,
      rateLimit: false,
    });

    // Prime the cache with 'a'.
    await provider.embed('a');
    expect(create).toHaveBeenCalledTimes(1);

    // 'a' is cached, 'bb' is not — only 'bb' should be sent.
    await provider.embedBatch!(['a', 'bb']);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith(
      // Single-element batches are sent as `input: 'bb'`, not `['bb']` —
      // matches the production code path's collapse-to-string optimization
      // for one-shot calls.
      expect.objectContaining({ input: 'bb' }),
    );
  });
});

describe('createOpenAIEmbeddingProvider — LRU cache (#19)', () => {
  it('cache hit on identical input avoids the provider call', async () => {
    const { client, create } = makeFakeClient();
    const provider = createOpenAIEmbeddingProvider({
      client,
      rateLimit: false,
    });

    const v1 = await provider.embed('once');
    const v2 = await provider.embed('once');

    expect(create).toHaveBeenCalledTimes(1);
    // Cache returns the SAME vector, not a re-fetched copy.
    expect(v1).toBe(v2);
  });

  it('evicts the LRU entry when capacity is exceeded', async () => {
    const { client, create } = makeFakeClient();
    const provider = createOpenAIEmbeddingProvider({
      client,
      rateLimit: false,
      cacheSize: 2,
    });

    await provider.embed('a'); // call 1, cache: [a]
    await provider.embed('b'); // call 2, cache: [a, b]
    await provider.embed('a'); // hit,    cache: [b, a]   (a moved to tail)
    await provider.embed('c'); // call 3, cache: [a, c]   (b evicted)
    await provider.embed('a'); // hit,    cache: [c, a]
    await provider.embed('b'); // call 4 — b was evicted so this misses

    expect(create).toHaveBeenCalledTimes(4);
  });

  it('cacheSize: 0 disables caching entirely', async () => {
    const { client, create } = makeFakeClient();
    const provider = createOpenAIEmbeddingProvider({
      client,
      rateLimit: false,
      cacheSize: 0,
    });

    await provider.embed('x');
    await provider.embed('x');
    await provider.embed('x');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('different models do not collide in the cache namespace', async () => {
    // Two providers configured for different models share no state because
    // each instance has its own LRU. We assert that here even though the
    // namespacing logic also lives in the cacheKey() builder — belt and
    // braces, since a future refactor to a shared cache would break this.
    const { client: c1, create: create1 } = makeFakeClient();
    const { client: c2, create: create2 } = makeFakeClient();
    const p1 = createOpenAIEmbeddingProvider({
      client: c1,
      model: 'model-a',
      rateLimit: false,
    });
    const p2 = createOpenAIEmbeddingProvider({
      client: c2,
      model: 'model-b',
      rateLimit: false,
    });

    await p1.embed('shared-input');
    await p2.embed('shared-input');

    expect(create1).toHaveBeenCalledTimes(1);
    expect(create2).toHaveBeenCalledTimes(1);
  });
});

describe('createOpenAIEmbeddingProvider — rate limiter (#19)', () => {
  it('throttles outbound calls when the bucket is empty', async () => {
    // 2 req per 1000ms with no burst headroom: 3rd call must wait ~500ms.
    // We use a fake clock to avoid real-time waits.
    let now = 0;
    const fakeNow = () => now;
    const sleeps: number[] = [];
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
      now += ms; // advance clock by the requested sleep
    };

    // Construct a hand-rolled bucket with the fake clock and inject it via
    // the limiter the provider builds internally — we can't override it
    // without exposing more API surface, so we test the limiter directly
    // and assert the provider PASSES `acquire` calls through to it.
    // (The integration that the provider actually uses the limiter is
    // verified by the next test, which counts calls under tight quota.)
    const bucket = new TokenBucket({
      ratePerInterval: 2,
      intervalMs: 1000,
      capacity: 2,
      now: fakeNow,
      sleep: fakeSleep,
    });

    await bucket.acquire(); // 2 → 1, no wait
    await bucket.acquire(); // 1 → 0, no wait
    expect(sleeps.length).toBe(0);

    await bucket.acquire(); // empty — must sleep ~500ms for the next token
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(500);
  });

  it('provider applies the rate limiter on each provider call', async () => {
    const { client, create } = makeFakeClient();
    // 1 req per 60s — the second back-to-back call would block.
    // We don't actually wait; we make the bucket capacity=1 and ASSERT
    // the second `embed` ends up queued (i.e., does not resolve before
    // the first completes). To keep the test fast, we use a tiny window.
    const provider = createOpenAIEmbeddingProvider({
      client,
      rateLimit: { ratePerInterval: 1, intervalMs: 50 },
      cacheSize: 0, // force every call to hit the limiter
    });

    const t0 = Date.now();
    await provider.embed('first'); // immediate
    await provider.embed('second'); // must wait ~50ms for refill
    const elapsed = Date.now() - t0;

    // Generous lower bound — slow CI machines should still satisfy this
    // even with timer jitter. Upper bound ensures we don't accidentally
    // wait a full minute.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rateLimit: false disables throttling entirely', async () => {
    const { client, create } = makeFakeClient();
    const provider = createOpenAIEmbeddingProvider({
      client,
      rateLimit: false,
      cacheSize: 0,
    });

    const t0 = Date.now();
    // 100 sequential calls — would take 100s at default 60/min.
    // With rate limiting disabled they should breeze through.
    for (let i = 0; i < 100; i++) {
      await provider.embed(`x-${i}`);
    }
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(create).toHaveBeenCalledTimes(100);
  });
});

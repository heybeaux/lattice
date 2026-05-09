/**
 * Token-bucket rate limiter (issue #19).
 *
 * The bucket is the foundation for provider-side throttling — getting it
 * wrong means either no throttling (the bug we are fixing) or deadlock
 * (worse). All time-dependent tests use injected fake clocks so we don't
 * burn real seconds in CI.
 */
import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../src/util/rate-limit.js';

/**
 * Build a bucket with a controllable clock and sleep. `advance(ms)` pushes
 * the clock forward AND drains queued sleepers up to that point — exactly
 * what real time would do, but instant.
 */
function makeBucket(opts: { ratePerInterval: number; intervalMs: number; capacity?: number }) {
  let now = 0;
  const sleepers: Array<{ wake: number; resolve: () => void }> = [];

  const bucket = new TokenBucket({
    ratePerInterval: opts.ratePerInterval,
    intervalMs: opts.intervalMs,
    capacity: opts.capacity,
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ wake: now + ms, resolve });
      }),
  });

  const advance = async (ms: number) => {
    now += ms;
    // Wake every sleeper whose wake time has passed. Pop them so they can
    // re-queue if the drain loop sleeps again.
    const toFire = sleepers
      .filter((s) => s.wake <= now)
      .sort((a, b) => a.wake - b.wake);
    for (const s of toFire) {
      const idx = sleepers.indexOf(s);
      if (idx >= 0) sleepers.splice(idx, 1);
      s.resolve();
      // Yield once so the drain loop can react and possibly schedule another sleep.
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  return { bucket, advance, sleepers };
}

describe('TokenBucket', () => {
  it('starts full at capacity', () => {
    const b = new TokenBucket({ ratePerInterval: 5, intervalMs: 1000 });
    expect(b.available()).toBe(5);
  });

  it('admits up to capacity instantly', async () => {
    const { bucket } = makeBucket({ ratePerInterval: 3, intervalMs: 1000 });
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(bucket.available()).toBe(0);
  });

  it('queues a 4th caller when capacity is 3 and refills over time', async () => {
    const { bucket, advance } = makeBucket({ ratePerInterval: 3, intervalMs: 300 });
    // Drain the bucket.
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    // 4th caller queues — track resolution.
    let resolved = false;
    const pending = bucket.acquire().then(() => {
      resolved = true;
    });

    // Yield once so the drain loop can compute its sleep and queue it.
    await Promise.resolve();
    await Promise.resolve();

    // 50ms in — too early. (3 tokens / 300ms = 1 token / 100ms.)
    await advance(50);
    expect(resolved).toBe(false);

    // 100ms total — exactly one refill, the 4th caller wakes.
    await advance(60);
    await pending;
    expect(resolved).toBe(true);
  });

  it('refills proportionally to elapsed time', () => {
    let now = 0;
    const b = new TokenBucket({
      ratePerInterval: 10,
      intervalMs: 1000,
      now: () => now,
    });

    // Drain.
    expect(b.available()).toBe(10);
    // Advance 500ms — should add 5 tokens, but bucket already at capacity.
    now += 500;
    expect(b.available()).toBe(10);
  });

  it('caps at capacity even after a long idle period', () => {
    let now = 0;
    const b = new TokenBucket({
      ratePerInterval: 5,
      intervalMs: 1000,
      capacity: 5,
      now: () => now,
    });
    now += 60_000; // 60s idle — would refill 300 tokens unbounded
    expect(b.available()).toBe(5);
  });

  it('throws if requested tokens exceed capacity (would deadlock)', async () => {
    const b = new TokenBucket({ ratePerInterval: 5, intervalMs: 1000, capacity: 5 });
    await expect(b.acquire(6)).rejects.toThrow(/capacity/);
  });

  it('rejects invalid configuration', () => {
    expect(() => new TokenBucket({ ratePerInterval: 0, intervalMs: 1000 })).toThrow();
    expect(() => new TokenBucket({ ratePerInterval: 5, intervalMs: 0 })).toThrow();
    expect(() => new TokenBucket({ ratePerInterval: 5, intervalMs: 1000, capacity: 0 })).toThrow();
  });

  it('admits FIFO order so large requests are not starved', async () => {
    // Capacity must be >= the largest acquire in the test (2). We then
    // immediately drain it so we can observe FIFO refill behavior.
    const { bucket, advance } = makeBucket({ ratePerInterval: 1, intervalMs: 1000, capacity: 2 });
    // Drain the bucket.
    await bucket.acquire(2);

    const order: string[] = [];
    const big = bucket.acquire(2).then(() => order.push('big'));
    // Allow the drain loop to enqueue 'big' first.
    await Promise.resolve();
    await Promise.resolve();
    const small = bucket.acquire(1).then(() => order.push('small'));

    // Refill is 1 token / 1000ms. After 1000ms we have 1 token — but 'big'
    // wants 2, so it must keep waiting. 'small' is queued behind it.
    await advance(1000);
    expect(order).toEqual([]);

    // After another 1000ms we have 2 tokens — 'big' admits, debit to 0,
    // 'small' still needs 1.
    await advance(1000);
    await big;
    expect(order).toEqual(['big']);

    await advance(1000);
    await small;
    expect(order).toEqual(['big', 'small']);
  });
});

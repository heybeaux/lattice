/**
 * Token-bucket rate limiter (issue #19, H12).
 *
 * The breaker's L2 path issues an embedding request on every validation.
 * Without a limiter, a busy pipeline can hammer the embedding provider with
 * unbounded concurrency, exhaust per-minute quotas, and turn provider 429s
 * into cascading L2 failures (which then escalate to L3 and amplify cost).
 *
 * Design notes:
 *  - Continuous refill (no per-second tick): tokens are computed lazily from
 *    elapsed wall-clock time on each `acquire`. This avoids a background
 *    timer (which would keep the process alive) and prevents drift.
 *  - `acquire(n=1)` returns a Promise that resolves once `n` tokens are
 *    available. While waiting, callers queue in arrival order — the limiter
 *    is FIFO so a long-running burst cannot starve the next caller.
 *  - The bucket caps at `capacity`, so an idle window does not let a single
 *    caller burn the next minute's budget in one shot. By default
 *    `capacity === ratePerInterval` (token bucket = leaky bucket of width
 *    `intervalMs`), which is what almost every provider quota actually is.
 *  - Zero external deps. ~80 lines of code.
 */

/** Configuration for the token-bucket limiter. */
export interface TokenBucketOptions {
  /**
   * Number of tokens replenished per `intervalMs`. Defaults to 60 (i.e. the
   * "60 requests per interval" target). Must be > 0.
   */
  ratePerInterval: number;
  /**
   * Refill window in milliseconds. Defaults to 60_000 (1 minute), so the
   * default bucket is "60 req/min". Must be > 0.
   */
  intervalMs?: number;
  /**
   * Bucket capacity (max burst). Defaults to `ratePerInterval` so a fully-
   * idle bucket can absorb one full interval's worth of requests in a burst
   * but no more. Must be >= 1.
   */
  capacity?: number;
  /**
   * Optional clock injection — defaults to `Date.now`. Tests pass a
   * controllable clock so they don't have to wait real time.
   */
  now?: () => number;
  /**
   * Optional sleeper injection — defaults to `setTimeout`. Tests pass a
   * fake-timer-aware sleeper. The signature mirrors `setTimeout` (called
   * with a callback and a delay in ms).
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Token-bucket rate limiter. See file header for design notes.
 *
 * Usage:
 * ```ts
 * const limiter = new TokenBucket({ ratePerInterval: 60 }); // 60/min
 * await limiter.acquire();           // wait for 1 token
 * await limiter.acquire(2);          // wait for 2 tokens (e.g. batch of 2)
 * ```
 *
 * The limiter is process-local. Callers spanning processes need an
 * out-of-band coordination mechanism (Redis, etc.) — this class deliberately
 * stays free of network deps.
 */
export class TokenBucket {
  private readonly ratePerInterval: number;
  private readonly intervalMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Current token count. Fractional values are normal — refill is continuous. */
  private tokens: number;
  /** Last time `tokens` was refreshed. */
  private lastRefill: number;
  /**
   * FIFO queue of pending waiters. Each entry holds the requested token count
   * and a resolve callback. Held in arrival order so we can fairly admit the
   * next waiter as soon as enough tokens are present.
   */
  private readonly queue: Array<{ n: number; resolve: () => void }> = [];
  /**
   * Whether a drain loop is already scheduled. Prevents duplicate timers when
   * multiple `acquire` calls arrive while the bucket is empty.
   */
  private draining = false;

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.ratePerInterval) || opts.ratePerInterval <= 0) {
      throw new Error(`TokenBucket: ratePerInterval must be > 0; got ${opts.ratePerInterval}`);
    }
    const intervalMs = opts.intervalMs ?? 60_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`TokenBucket: intervalMs must be > 0; got ${intervalMs}`);
    }
    const capacity = opts.capacity ?? opts.ratePerInterval;
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(`TokenBucket: capacity must be >= 1; got ${capacity}`);
    }

    this.ratePerInterval = opts.ratePerInterval;
    this.intervalMs = intervalMs;
    this.capacity = capacity;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    // Start full so the first burst doesn't have to wait an interval.
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /**
   * Acquire `n` tokens (default 1). Resolves once the bucket has been
   * debited. Throws synchronously if `n > capacity` since that would
   * deadlock — the bucket can never satisfy the request.
   */
  async acquire(n = 1): Promise<void> {
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`TokenBucket.acquire: n must be >= 1; got ${n}`);
    }
    if (n > this.capacity) {
      throw new Error(
        `TokenBucket.acquire: requested ${n} tokens but capacity is only ${this.capacity}`,
      );
    }

    this.refill();

    // Fast path — bucket has enough AND no one is queued ahead of us.
    if (this.queue.length === 0 && this.tokens >= n) {
      this.tokens -= n;
      return;
    }

    // Slow path — queue and wait. The drain loop will resolve our promise.
    return new Promise<void>((resolve) => {
      this.queue.push({ n, resolve });
      this.scheduleDrain();
    });
  }

  /**
   * Synchronously update the token count from elapsed time. Idempotent.
   * Pulled out so both `acquire` and the drain loop can use it.
   */
  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;

    const refilled = (elapsed / this.intervalMs) * this.ratePerInterval;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefill = now;
  }

  /**
   * Background drain loop — wakes up periodically and admits queued waiters
   * as tokens become available. We compute the *exact* sleep duration each
   * iteration so we never busy-wait or over-sleep past the next admission.
   */
  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drainLoop();
  }

  private async drainLoop(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        this.refill();

        // Admit as many head-of-queue waiters as we can right now. We do not
        // skip past a blocked waiter to admit a smaller one further back —
        // that would be unfair and could starve large requests.
        while (this.queue.length > 0 && this.tokens >= this.queue[0].n) {
          const next = this.queue.shift()!;
          this.tokens -= next.n;
          next.resolve();
        }

        if (this.queue.length === 0) break;

        // Compute the time until the head waiter has enough tokens. Refill
        // rate is `ratePerInterval / intervalMs` tokens per ms.
        const needed = this.queue[0].n - this.tokens;
        const tokensPerMs = this.ratePerInterval / this.intervalMs;
        // Defend against tokensPerMs === 0 (would happen with an
        // absurdly-small rate), though our constructor rejects that case.
        const waitMs = Math.max(1, Math.ceil(needed / tokensPerMs));
        await this.sleep(waitMs);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Tokens currently available (read-only). Refills on read so callers see
   * an accurate snapshot. Used by tests and observability — production
   * callers should use `acquire`.
   */
  available(): number {
    this.refill();
    return this.tokens;
  }
}

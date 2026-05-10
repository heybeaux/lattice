import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProviderTimeoutError,
  ProviderRateLimitError,
  MalformedProviderResponseError,
  withTimeout,
  withRateLimit,
  isProviderError,
  TieredCircuitBreaker,
  createContract,
} from '../src/index.js';
import type { EmbeddingProvider } from '../src/index.js';

// ─── ProviderTimeoutError ────────────────────────────────────────────────────

describe('ProviderTimeoutError', () => {
  it('stores provider and timeoutMs fields', () => {
    const err = new ProviderTimeoutError('openai', 5000);
    expect(err.provider).toBe('openai');
    expect(err.timeoutMs).toBe(5000);
  });

  it('generates a descriptive message', () => {
    const err = new ProviderTimeoutError('anthropic', 3000);
    expect(err.message).toContain('anthropic');
    expect(err.message).toContain('3000');
  });

  it('has correct name', () => {
    const err = new ProviderTimeoutError('openai', 1000);
    expect(err.name).toBe('ProviderTimeoutError');
  });

  it('is an instance of Error', () => {
    const err = new ProviderTimeoutError('openai', 1000);
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of ProviderTimeoutError', () => {
    const err = new ProviderTimeoutError('openai', 1000);
    expect(err).toBeInstanceOf(ProviderTimeoutError);
  });
});

// ─── ProviderRateLimitError ──────────────────────────────────────────────────

describe('ProviderRateLimitError', () => {
  it('stores provider field', () => {
    const err = new ProviderRateLimitError('openai');
    expect(err.provider).toBe('openai');
  });

  it('stores optional retryAfterMs field', () => {
    const err = new ProviderRateLimitError('openai', 30000);
    expect(err.retryAfterMs).toBe(30000);
  });

  it('retryAfterMs is undefined when not provided', () => {
    const err = new ProviderRateLimitError('openai');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('generates a descriptive message', () => {
    const err = new ProviderRateLimitError('cohere', 5000);
    expect(err.message).toContain('cohere');
    expect(err.message).toContain('5000');
  });

  it('has correct name', () => {
    const err = new ProviderRateLimitError('openai');
    expect(err.name).toBe('ProviderRateLimitError');
  });

  it('is an instance of Error', () => {
    const err = new ProviderRateLimitError('openai');
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── MalformedProviderResponseError ─────────────────────────────────────────

describe('MalformedProviderResponseError', () => {
  it('stores provider and rawResponse fields', () => {
    const err = new MalformedProviderResponseError('openai', '{"bad": "json"');
    expect(err.provider).toBe('openai');
    expect(err.rawResponse).toBe('{"bad": "json"');
  });

  it('truncates rawResponse to 500 characters', () => {
    const longResponse = 'x'.repeat(1000);
    const err = new MalformedProviderResponseError('openai', longResponse);
    expect(err.rawResponse.length).toBe(500);
  });

  it('does not truncate when rawResponse is <=500 chars', () => {
    const short = 'x'.repeat(300);
    const err = new MalformedProviderResponseError('openai', short);
    expect(err.rawResponse.length).toBe(300);
  });

  it('generates a descriptive message', () => {
    const err = new MalformedProviderResponseError('vertex', 'raw');
    expect(err.message).toContain('vertex');
  });

  it('has correct name', () => {
    const err = new MalformedProviderResponseError('openai', 'raw');
    expect(err.name).toBe('MalformedProviderResponseError');
  });

  it('is an instance of Error', () => {
    const err = new MalformedProviderResponseError('openai', 'raw');
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── withTimeout ─────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves when fn completes before timeout', async () => {
    const result = await withTimeout(() => Promise.resolve(42), 1000, 'openai');
    expect(result).toBe(42);
  });

  it('rejects with ProviderTimeoutError when fn exceeds timeout', async () => {
    vi.useFakeTimers();

    const slowFn = () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5000));
    const racePromise = withTimeout(slowFn, 100, 'openai');

    // Advance timers past the timeout
    vi.advanceTimersByTime(200);

    await expect(racePromise).rejects.toBeInstanceOf(ProviderTimeoutError);

    vi.useRealTimers();
  });

  it('ProviderTimeoutError from withTimeout has correct provider and timeoutMs', async () => {
    vi.useFakeTimers();

    const slowFn = () => new Promise<void>((resolve) => setTimeout(resolve, 5000));
    const racePromise = withTimeout(slowFn, 250, 'anthropic');

    vi.advanceTimersByTime(300);

    try {
      await racePromise;
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderTimeoutError);
      const te = err as ProviderTimeoutError;
      expect(te.provider).toBe('anthropic');
      expect(te.timeoutMs).toBe(250);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates non-timeout errors unchanged', async () => {
    const boom = new Error('boom');
    await expect(withTimeout(() => Promise.reject(boom), 1000, 'openai')).rejects.toBe(boom);
  });
});

// ─── withRateLimit ────────────────────────────────────────────────────────────

describe('withRateLimit', () => {
  it('passes through when fn resolves successfully', async () => {
    const result = await withRateLimit(() => Promise.resolve('ok'), 'openai');
    expect(result).toBe('ok');
  });

  it('wraps a 429 error into ProviderRateLimitError after retries exhausted', async () => {
    const rateLimitErr = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn().mockRejectedValue(rateLimitErr);

    await expect(
      withRateLimit(fn, 'openai', 2, 0), // 2 retries, 0ms delay
    ).rejects.toBeInstanceOf(ProviderRateLimitError);

    // Called once initially + 2 retries = 3 total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('wraps a "rate limit" message error after retries', async () => {
    const rateLimitErr = new Error('You have exceeded the rate limit');
    const fn = vi.fn().mockRejectedValue(rateLimitErr);

    const err = await withRateLimit(fn, 'cohere', 1, 0).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).provider).toBe('cohere');
  });

  it('rethrows non-rate-limit errors immediately without retrying', async () => {
    const boom = new Error('network error');
    const fn = vi.fn().mockRejectedValue(boom);

    await expect(withRateLimit(fn, 'openai', 3, 0)).rejects.toBe(boom);
    // Only called once — no retries for non-rate-limit errors
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds on retry after transient rate limit', async () => {
    const rateLimitErr = Object.assign(new Error('429'), { status: 429 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValue('success');

    const result = await withRateLimit(fn, 'openai', 3, 0);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ─── isProviderError ─────────────────────────────────────────────────────────

describe('isProviderError', () => {
  it('returns true for ProviderTimeoutError', () => {
    expect(isProviderError(new ProviderTimeoutError('x', 1000))).toBe(true);
  });

  it('returns true for ProviderRateLimitError', () => {
    expect(isProviderError(new ProviderRateLimitError('x'))).toBe(true);
  });

  it('returns true for MalformedProviderResponseError', () => {
    expect(isProviderError(new MalformedProviderResponseError('x', 'raw'))).toBe(true);
  });

  it('returns false for generic Error', () => {
    expect(isProviderError(new Error('generic'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isProviderError(null)).toBe(false);
  });
});

// ─── Integration: TieredCircuitBreaker graceful degradation ─────────────────

describe('TieredCircuitBreaker — graceful degradation with onReject: degrade', () => {
  function makeContract() {
    return createContract({
      fromAgent: 'test-agent',
      inputs: { task: 'do something' },
      outputs: { result: 'done' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 10 },
    });
  }

  it('continues validation (passed=true) when embedding provider throws ProviderTimeoutError', async () => {
    const failingProvider: EmbeddingProvider = {
      embed: async () => {
        throw new ProviderTimeoutError('openai', 5000);
      },
      similarity: () => 1.0,
    };

    const cb = new TieredCircuitBreaker({ tier: 'L1+L2', onReject: 'degrade' });
    cb.setEmbeddingProvider(failingProvider);

    const result = await cb.validate(makeContract());
    expect(result.passed).toBe(true);
    expect(result.providerFailure).toBe(true);
    expect(result.metadata?.providerFailure).toBe(true);
  });

  it('continues validation when embedding provider throws ProviderRateLimitError', async () => {
    const failingProvider: EmbeddingProvider = {
      embed: async () => {
        throw new ProviderRateLimitError('openai', 30000);
      },
      similarity: () => 1.0,
    };

    const cb = new TieredCircuitBreaker({ tier: 'L1+L2', onReject: 'degrade' });
    cb.setEmbeddingProvider(failingProvider);

    const result = await cb.validate(makeContract());
    expect(result.passed).toBe(true);
    expect(result.providerFailure).toBe(true);
  });

  it('continues validation when embedding provider throws MalformedProviderResponseError', async () => {
    const failingProvider: EmbeddingProvider = {
      embed: async () => {
        throw new MalformedProviderResponseError('openai', 'garbage');
      },
      similarity: () => 1.0,
    };

    const cb = new TieredCircuitBreaker({ tier: 'L1+L2', onReject: 'degrade' });
    cb.setEmbeddingProvider(failingProvider);

    const result = await cb.validate(makeContract());
    expect(result.passed).toBe(true);
    expect(result.providerFailure).toBe(true);
  });

  it('does NOT degrade (rethrows) when onReject is abort (default)', async () => {
    const failingProvider: EmbeddingProvider = {
      embed: async () => {
        throw new ProviderTimeoutError('openai', 5000);
      },
      similarity: () => 1.0,
    };

    // Default onReject is 'abort'
    const cb = new TieredCircuitBreaker({ tier: 'L1+L2' });
    cb.setEmbeddingProvider(failingProvider);

    const result = await cb.validate(makeContract());
    // With abort mode the error is caught generically and returns passed:false
    expect(result.passed).toBe(false);
    expect(result.providerFailure).toBeUndefined();
  });
});

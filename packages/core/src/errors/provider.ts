/**
 * Provider error classes and utility wrappers for Section 5 error boundaries.
 *
 * @module errors/provider
 */

// ─── Error Classes ────────────────────────────────────────────────────────────

/**
 * Thrown when a provider call exceeds the configured timeout.
 */
export class ProviderTimeoutError extends Error {
  readonly provider: string;
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number) {
    super(`Provider "${provider}" timed out after ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
    this.provider = provider;
    this.timeoutMs = timeoutMs;
    // Restore prototype chain for instanceof checks across realms / transpilers.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a provider responds with HTTP 429 (rate limit exceeded)
 * or an equivalent signal.
 */
export class ProviderRateLimitError extends Error {
  readonly provider: string;
  readonly retryAfterMs?: number;

  constructor(provider: string, retryAfterMs?: number) {
    const suffix = retryAfterMs != null ? ` Retry after ${retryAfterMs}ms.` : '';
    super(`Provider "${provider}" rate limit exceeded.${suffix}`);
    this.name = 'ProviderRateLimitError';
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a provider returns a response that cannot be parsed or
 * does not conform to the expected shape.
 *
 * `rawResponse` is truncated to 500 characters for debugging without
 * risking unbounded log growth.
 */
export class MalformedProviderResponseError extends Error {
  readonly provider: string;
  readonly rawResponse: string;

  constructor(provider: string, rawResponse: string) {
    const truncated = rawResponse.length > 500 ? rawResponse.slice(0, 500) : rawResponse;
    super(`Provider "${provider}" returned a malformed response`);
    this.name = 'MalformedProviderResponseError';
    this.provider = provider;
    this.rawResponse = truncated;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Utility Wrappers ─────────────────────────────────────────────────────────

/**
 * Races `fn()` against a timeout. Rejects with {@link ProviderTimeoutError}
 * if `timeoutMs` elapses before `fn` resolves.
 *
 * @example
 * ```ts
 * const result = await withTimeout(() => provider.embed(text), 5000, 'openai');
 * ```
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  provider: string,
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new ProviderTimeoutError(provider, timeoutMs)),
      timeoutMs,
    );
    // Allow Node.js to exit cleanly if only the timer remains.
    if (typeof timerId === 'object' && typeof (timerId as any).unref === 'function') {
      (timerId as any).unref();
    }
  });

  try {
    // clearTimeout is called when fn() wins the race so the timer is not
    // left dangling in environments that do not support .unref() (e.g.
    // browsers, Deno, edge runtimes).
    const result = await Promise.race([fn(), timeout]);
    clearTimeout(timerId);
    return result;
  } catch (err) {
    clearTimeout(timerId);
    throw err;
  }
}

/**
 * Detects whether `err` represents a 429 / rate-limit condition from a
 * provider SDK. Checks:
 * - `err.status === 429`
 * - `err.statusCode === 429`
 * - `err.message` contains "rate limit" (case-insensitive)
 */
function isRateLimitError(err: unknown): { retryAfterMs?: number } | null {
  if (err == null || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;

  const status = (e['status'] ?? e['statusCode']) as number | undefined;
  const message = typeof e['message'] === 'string' ? e['message'] : '';

  if (status === 429 || /rate.?limit/i.test(message)) {
    // Try to parse Retry-After in seconds from common SDK shapes.
    const retryAfterSec =
      (e['headers'] as any)?.['retry-after'] ??
      (e['retryAfter'] as any) ??
      null;
    const retryAfterMs =
      retryAfterSec != null ? Math.round(Number(retryAfterSec) * 1000) : undefined;
    return { retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined };
  }

  return null;
}

/**
 * Wraps `fn()` with exponential-backoff retry logic for rate-limit errors.
 * On a 429-style error the wrapper retries up to `maxRetries` times (default 3)
 * with exponential backoff, then rethrows as {@link ProviderRateLimitError}.
 *
 * Non-rate-limit errors are rethrown immediately without retrying.
 *
 * @param fn        - The async operation to execute.
 * @param provider  - Provider name used in {@link ProviderRateLimitError}.
 * @param maxRetries - Total retry attempts after the first failure (default 3).
 * @param baseDelayMs - Initial backoff delay in ms before the first retry (default 500).
 */
export async function withRateLimit<T>(
  fn: () => Promise<T>,
  provider: string,
  maxRetries = 3,
  baseDelayMs = 500,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const rateLimitInfo = isRateLimitError(err);
      if (rateLimitInfo === null) {
        // Not a rate-limit error — propagate immediately.
        throw err;
      }

      attempt++;
      if (attempt > maxRetries) {
        throw new ProviderRateLimitError(provider, rateLimitInfo.retryAfterMs);
      }

      // Respect Retry-After from the provider if available; otherwise use
      // exponential backoff: baseDelayMs * 2^(attempt-1).
      const delay = rateLimitInfo.retryAfterMs ?? baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ─── Type Guard ───────────────────────────────────────────────────────────────

/**
 * Returns `true` when `err` is one of the three known provider error types
 * ({@link ProviderTimeoutError}, {@link ProviderRateLimitError},
 * {@link MalformedProviderResponseError}).
 */
export function isProviderError(
  err: unknown,
): err is ProviderTimeoutError | ProviderRateLimitError | MalformedProviderResponseError {
  return (
    err instanceof ProviderTimeoutError ||
    err instanceof ProviderRateLimitError ||
    err instanceof MalformedProviderResponseError
  );
}

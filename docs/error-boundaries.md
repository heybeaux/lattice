# Error Boundaries

Lattice v0.4 introduces typed error classes and utility wrappers for provider failures. These give you precise control over timeout handling, rate limiting, and graceful degradation.

## Error Classes

All three classes extend `Error` with provider-specific context. Import them from `@heybeaux/lattice-core`.

### `ProviderTimeoutError`

Thrown when a provider call (embedding or judge) does not respond within the configured timeout window.

```typescript
class ProviderTimeoutError extends Error {
  readonly name: 'ProviderTimeoutError';
  /** Provider name (e.g. 'openai') */
  readonly provider: string;
  /** Configured timeout in milliseconds */
  readonly timeoutMs: number;
}
```

**Example message:** `Provider "openai" timed out after 5000ms`

### `ProviderRateLimitError`

Thrown when a provider returns HTTP 429 (rate limit exceeded) after exhausting all retry attempts.

```typescript
class ProviderRateLimitError extends Error {
  readonly name: 'ProviderRateLimitError';
  /** Provider name */
  readonly provider: string;
  /**
   * Milliseconds to wait before retrying, parsed from the Retry-After header.
   * Undefined if the provider did not supply the header.
   */
  readonly retryAfterMs?: number;
}
```

**Example message:** `Provider "openai" rate limit exceeded. Retry after 60000ms.`

### `MalformedProviderResponseError`

Thrown when a provider returns a response that cannot be parsed or does not conform to the expected shape.

```typescript
class MalformedProviderResponseError extends Error {
  readonly name: 'MalformedProviderResponseError';
  /** Provider name */
  readonly provider: string;
  /** Raw response string, truncated to 500 characters */
  readonly rawResponse: string;
}
```

**Example message:** `Provider "openai" returned a malformed response`

### Type Guard: `isProviderError`

```typescript
import { isProviderError } from '@heybeaux/lattice-core';

try {
  await breaker.validate(contract);
} catch (err) {
  if (isProviderError(err)) {
    // err is ProviderTimeoutError | ProviderRateLimitError | MalformedProviderResponseError
    console.error(`Provider failure from: ${err.provider}`);
  }
}
```

---

## Utility Wrappers

### `withTimeout`

Races an async function against a deadline. Rejects with `ProviderTimeoutError` if the deadline is reached first.

```typescript
function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  provider: string,
): Promise<T>
```

**Usage:**

```typescript
import { withTimeout, ProviderTimeoutError } from '@heybeaux/lattice-core';

try {
  const embedding = await withTimeout(
    () => myEmbeddingClient.embed(text),
    5000,   // timeout in ms
    'openai',
  );
} catch (err) {
  if (err instanceof ProviderTimeoutError) {
    console.error(`Timed out after ${err.timeoutMs}ms`);
  }
}
```

The timer uses `unref()` on Node.js so it will never prevent the process from exiting cleanly.

### `withRateLimit`

Wraps an async function with exponential-backoff retry logic for rate-limit errors. On a 429-style response, retries up to `maxRetries` times. After all retries are exhausted, throws `ProviderRateLimitError`.

Non-rate-limit errors are rethrown immediately without retrying.

```typescript
function withRateLimit<T>(
  fn: () => Promise<T>,
  provider: string,
  maxRetries?: number,    // default: 3
  baseDelayMs?: number,   // default: 500ms
): Promise<T>
```

**How it detects rate limits:**
- `err.status === 429`
- `err.statusCode === 429`
- `err.message` matches `/rate.?limit/i`

**Backoff schedule (default config):**

| Attempt | Delay |
|---------|-------|
| 1st retry | 500ms |
| 2nd retry | 1000ms |
| 3rd retry | 2000ms |
| Throws `ProviderRateLimitError` | — |

If the provider includes a `Retry-After` header, that value is used instead of the exponential backoff.

**Usage:**

```typescript
import { withRateLimit, ProviderRateLimitError } from '@heybeaux/lattice-core';

try {
  const result = await withRateLimit(
    () => myClient.embeddings.create({ model: 'text-embedding-3-small', input: text }),
    'openai',
    3,    // max retries
    500,  // base delay ms
  );
} catch (err) {
  if (err instanceof ProviderRateLimitError) {
    console.error(`Rate limited. Retry after ${err.retryAfterMs ?? 'unknown'}ms`);
  }
}
```

**Combining timeout and rate-limit:**

```typescript
const result = await withRateLimit(
  () => withTimeout(() => myClient.embed(text), 5000, 'openai'),
  'openai',
);
```

---

## Graceful Degradation with `onReject: 'degrade'`

By default (`onReject: 'abort'`), a provider failure in L2 or L3 validation causes the circuit breaker to record a failure and reject the contract. With `onReject: 'degrade'`, known provider errors instead produce a **passing** result flagged with `providerFailure: true` — the pipeline continues, but the flag surfaces for downstream observability.

### When to use `degrade`

- Your L2/L3 providers are best-effort (e.g. embedding similarity enriches quality but is not a hard gate)
- Provider outages should not bring down your pipeline
- You want to observe failures without blocking production traffic

### Configuration

```typescript
import { TieredCircuitBreaker } from '@heybeaux/lattice-core';
import { createOpenAIEmbeddingProvider } from '@heybeaux/lattice-provider-openai';

const breaker = new TieredCircuitBreaker({
  tier: 'L1+L2',
  onReject: 'degrade',  // 'abort' | 'degrade'
});

breaker.setEmbeddingProvider(
  createOpenAIEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY }),
);
```

### Behavior

When `onReject: 'degrade'` and a **known provider error** (`ProviderTimeoutError`, `ProviderRateLimitError`, `MalformedProviderResponseError`) occurs during L2 or L3 validation, the result is:

```typescript
{
  passed: true,       // pipeline continues
  tier: 'L2',        // or 'L3'
  durationMs: 47,
  providerFailure: true,         // flag indicating degradation
  metadata: { providerFailure: true },
}
```

Unknown errors (bugs in your code, network errors that are not typed as provider errors) still propagate as failures regardless of `onReject`.

### Example: Checking for Degradation

```typescript
import { TieredCircuitBreaker } from '@heybeaux/lattice-core';

const breaker = new TieredCircuitBreaker({ tier: 'L1+L2', onReject: 'degrade' });

const result = await breaker.validate(contract);

if (result.passed && result.providerFailure) {
  console.warn(`Validation passed in degrade mode — provider unavailable for ${result.tier}`);
  // Emit a metric, add to an audit flag, alert ops, etc.
}
```

### In a pipeline

```typescript
import { pipeline } from '@heybeaux/lattice-core';

const p = pipeline()
  .agent('researcher', researchFn, { breaker: { tier: 'L1+L2' } })
  .agent('writer', writeFn, { breaker: { tier: 'L1' } })
  .onReject('degrade')
  .build();

const result = await p.execute({ query: 'AI coordination' });

if (result.hadRejected) {
  // At least one contract was flagged (degrade mode)
  console.warn('Pipeline completed with degraded validation.');
}
```

---

## Catching All Provider Errors

```typescript
import {
  ProviderTimeoutError,
  ProviderRateLimitError,
  MalformedProviderResponseError,
  isProviderError,
} from '@heybeaux/lattice-core';

async function safeValidate(contract: StateContract) {
  try {
    return await breaker.validate(contract);
  } catch (err) {
    if (err instanceof ProviderTimeoutError) {
      metrics.increment('provider.timeout', { provider: err.provider });
      throw err;
    }
    if (err instanceof ProviderRateLimitError) {
      metrics.increment('provider.rate_limit', { provider: err.provider });
      // Schedule retry after err.retryAfterMs
      throw err;
    }
    if (err instanceof MalformedProviderResponseError) {
      logger.error('Malformed provider response', {
        provider: err.provider,
        sample: err.rawResponse,
      });
      throw err;
    }
    throw err;
  }
}
```

See [examples/error-boundaries.ts](../examples/error-boundaries.ts) for a runnable demo.

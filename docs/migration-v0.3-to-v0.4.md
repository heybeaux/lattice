# Migration Guide: v0.3 → v0.4

## Zero Breaking Changes

**All v0.3 code works unchanged in v0.4.** You can upgrade by bumping the version and nothing will break. Every new feature is opt-in.

```bash
npm install @heybeaux/lattice-core@0.4.0 @heybeaux/lattice-provider-openai@0.4.0
```

---

## What's New in v0.4

| Feature | What it adds | How to opt in |
|---------|--------------|---------------|
| **Persistent Circuit State** | Circuit breaker state survives restarts | Pass `persistence` to `CircuitBreaker` |
| **L2 Embedding** | Semantic consistency via embeddings | Call `breaker.setEmbeddingProvider(...)` |
| **Structured Observability** | JSON-line log + OTel spans | Attach `JsonLineExporter` / `OtelExporter` |
| **Config File** | `lattice.config.json` auto-discovery | Drop a config file in your project root |
| **Error Boundaries** | Typed provider errors + `withTimeout` / `withRateLimit` | Already imported from `@heybeaux/lattice-core` |
| **Graceful Degradation** | `onReject: 'degrade'` for provider failures | Pass `onReject: 'degrade'` to `TieredCircuitBreaker` |

---

## Side-by-Side Examples

### 1. CircuitBreaker — Adding Persistence

**v0.3 (unchanged, still works):**

```typescript
import { CircuitBreaker } from '@heybeaux/lattice-core';

const breaker = new CircuitBreaker({ failureThreshold: 3 });
```

**v0.4 — opt in to persistence:**

```typescript
import { CircuitBreaker } from '@heybeaux/lattice-core';
import { JsonFileBackend } from '@heybeaux/lattice-core/dist/breaker/persistence.js';

const backend = new JsonFileBackend('./data/circuit-state.json');

const breaker = new CircuitBreaker({
  id: 'my-breaker',           // needed to look up state in the file
  failureThreshold: 3,
  persistence: backend,
});

// Call once on startup to restore state from a previous run
await breaker.restoreState();
```

---

### 2. TieredCircuitBreaker — Adding L2 Embeddings

**v0.3 (unchanged):**

```typescript
import { TieredCircuitBreaker } from '@heybeaux/lattice-core';

const breaker = new TieredCircuitBreaker({ tier: 'L1' });
const result = await breaker.validate(contract);
```

**v0.4 — opt in to L2 semantic consistency:**

```typescript
import { TieredCircuitBreaker } from '@heybeaux/lattice-core';
import { createOpenAIEmbeddingProvider } from '@heybeaux/lattice-provider-openai';

// Same constructor — just add a tier and provider
const breaker = new TieredCircuitBreaker({ tier: 'L1+L2' });
breaker.setEmbeddingProvider(
  createOpenAIEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY }),
);

const result = await breaker.validate(contract);
// L1 (<1ms) + L2 (50-200ms, batched with LRU cache)
```

---

### 3. wrapAgent — No Changes Required

**v0.3:**

```typescript
import { wrapAgent } from '@heybeaux/lattice-core';

const wrapped = wrapAgent(myFn, {
  id: 'researcher',
  breaker: { tier: 'L1' },
});
```

**v0.4 — everything above still works as-is.** Optionally add observability:

```typescript
import { wrapAgent, JsonLineExporter, globalEmitter } from '@heybeaux/lattice-core';

// Attach exporter once at startup — affects all wrapAgent calls automatically
new JsonLineExporter({ outputPath: './logs/lattice.jsonl' }).attach(globalEmitter);

const wrapped = wrapAgent(myFn, {
  id: 'researcher',
  breaker: { tier: 'L1' },
});
```

---

### 4. pipeline() — No Changes Required

**v0.3:**

```typescript
import { pipeline, HandoffFailure } from '@heybeaux/lattice-core';

const p = pipeline()
  .agent('researcher', researchFn, { breaker: { tier: 'L1+L3' } })
  .agent('writer', writeFn, { breaker: { tier: 'L1' } })
  .onReject('retry', { maxRetries: 2 })
  .build();

const result = await p.execute({ query: 'AI coordination' });
```

**v0.4 — same code works, optionally add degrade mode or observability:**

```typescript
import { pipeline, HandoffFailure, OtelExporter, globalEmitter } from '@heybeaux/lattice-core';

// Optional: OTel spans for this pipeline
new OtelExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-pipeline',
}).attach(globalEmitter);

const p = pipeline()
  .agent('researcher', researchFn, { breaker: { tier: 'L1+L3' } })
  .agent('writer', writeFn, { breaker: { tier: 'L1' } })
  .onReject('retry', { maxRetries: 2 })
  .build();

const result = await p.execute({ query: 'AI coordination' });
```

---

### 5. Error Handling — New Typed Errors

**v0.3 — generic error handling:**

```typescript
try {
  await breaker.validate(contract);
} catch (err) {
  console.error('Validation failed:', err);
}
```

**v0.4 — typed provider errors (already available, no code change needed to existing catch blocks):**

```typescript
import {
  ProviderTimeoutError,
  ProviderRateLimitError,
  MalformedProviderResponseError,
} from '@heybeaux/lattice-core';

try {
  await breaker.validate(contract);
} catch (err) {
  // New: distinguish provider failures from logic failures
  if (err instanceof ProviderTimeoutError) {
    console.error(`${err.provider} timed out after ${err.timeoutMs}ms`);
  } else if (err instanceof ProviderRateLimitError) {
    console.error(`Rate limited. Retry after ${err.retryAfterMs ?? '?'}ms`);
  } else if (err instanceof MalformedProviderResponseError) {
    console.error(`Bad response from ${err.provider}: ${err.rawResponse}`);
  } else {
    throw err; // Unknown — rethrow
  }
}
```

---

## New Exports in v0.4

The following are newly exported from `@heybeaux/lattice-core`:

```typescript
// Observability
export { JsonLineExporter } from './observability/json-line.js';
export { OtelExporter } from './observability/otel.js';
export type { JsonLineEntry, JsonLineExporterConfig, OtelSpan, OtelExporterConfig };

// Config
export { createConfig, createConfigAsync, defaultConfig, discoverConfig } from './config/loader.js';
export { ConfigValidationError } from './config/loader.js';
export type { LatticeConfig };

// Error Boundaries
export {
  ProviderTimeoutError,
  ProviderRateLimitError,
  MalformedProviderResponseError,
  withTimeout,
  withRateLimit,
  isProviderError,
} from './errors/provider.js';

// Persistence (as types)
export type { PersistenceBackend, PersistedBreakerState } from './breaker/persistence.js';
```

And from `@heybeaux/lattice-provider-openai`:

```typescript
export function createOpenAIEmbeddingProvider(config?: OpenAIEmbeddingConfig): EmbeddingProvider;
export type { OpenAIEmbeddingConfig };
```

---

## Checklist

When upgrading from v0.3 to v0.4, there is nothing you _must_ do. But here are the optional steps to take full advantage of the new features:

- [ ] Add `lattice.config.json` to your project root ([docs/config.md](./config.md))
- [ ] Pass `persistence` to `CircuitBreaker` for across-restart durability
- [ ] Call `await breaker.restoreState()` on startup when using persistence
- [ ] Attach `JsonLineExporter` to `globalEmitter` for structured logging
- [ ] Attach `OtelExporter` for distributed tracing (if you have an OTLP backend)
- [ ] Set `onReject: 'degrade'` in `TieredCircuitBreaker` for resilient L2/L3 paths
- [ ] Catch `ProviderTimeoutError` / `ProviderRateLimitError` for provider-specific handling

# Lattice Examples

## Quick Start

See Lattice in action — run the interactive demo:

```bash
npx tsx examples/quick-start/demo.ts
```

This demonstrates:
1. **Healthy pipeline** — 3 agents composing output with State Contracts at each handoff
2. **Circuit breaker** — catching a failing agent before it cascades
3. **Redaction** — scrubbing API keys and secrets from logged output
4. **Degrade mode** — continuing on failure with flagged contracts

## v0.4 Examples

### Persistent Circuit Breaker

```bash
npx tsx examples/persistent-breaker.ts
```

Demonstrates `CircuitBreaker` with `JsonFileBackend` so circuit state survives
process restarts. Run twice to see state restored from disk.

No API keys required.

### L2 Embedding

```bash
# With real OpenAI embeddings:
OPENAI_API_KEY=sk-... npx tsx examples/l2-embedding.ts

# Without API key (uses mock provider):
npx tsx examples/l2-embedding.ts
```

Demonstrates `TieredCircuitBreaker` with `createOpenAIEmbeddingProvider()` for
semantic consistency validation (L2 tier). Shows degrade mode when the provider fails.

### Observability

```bash
npx tsx examples/observability.ts
```

Demonstrates `JsonLineExporter` (always available) and `OtelExporter` (optional OTel
peer deps) attached to `globalEmitter`. Runs a pipeline and shows the resulting `.jsonl`
log entries. Writes to `./tmp/lattice-events.jsonl`.

No API keys required. OTel output requires a running OTLP backend (see script for
a one-line Docker command to start Jaeger locally).

### Error Boundaries

```bash
npx tsx examples/error-boundaries.ts
```

Demonstrates `withTimeout`, `withRateLimit`, typed provider errors
(`ProviderTimeoutError`, `ProviderRateLimitError`), and `onReject: 'degrade'`.

No API keys required.

## Forge Integration

See `../packages/adapter-mastra/src/examples/forge-linkedin.ts` for how to wrap Forge's existing Mastra steps with Lattice coordination.

## Requirements

- Node.js 20+
- No API keys needed for the quick start demo or v0.4 examples (L1-only / mocks)
- `OPENAI_API_KEY` environment variable for real L2/L3 validation

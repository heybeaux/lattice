# Lattice

**Coordination infrastructure for multi-agent AI systems.**

[![npm](https://img.shields.io/npm/v/@heybeaux/lattice-core.svg)](https://www.npmjs.com/package/@heybeaux/lattice-core)
[![npm](https://img.shields.io/npm/v/@heybeaux/lattice-provider-openai.svg)](https://www.npmjs.com/package/@heybeaux/lattice-provider-openai)
[![npm](https://img.shields.io/npm/v/@heybeaux/lattice-adapter-mastra.svg)](https://www.npmjs.com/package/@heybeaux/lattice-adapter-mastra)
[![PyPI](https://img.shields.io/pypi/v/lattice-langgraph.svg)](https://pypi.org/project/lattice-langgraph/)
[![PyPI](https://img.shields.io/pypi/v/lattice-crewai.svg)](https://pypi.org/project/lattice-crewai/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Benchmark](https://img.shields.io/badge/benchmark-real_results-green)](https://github.com/heybeaux/lattice/tree/main/benchmark)

> Like threading libraries for concurrent programming — but for AI agents.

Multi-agent AI systems fail at high rates due to **structural coordination failures**, not model quality. Lattice provides the primitives — State Contracts, Circuit Breakers, Pipeline orchestration — that make multi-agent systems reliable.

## Status

| Package | Version | Status | Notes |
|---------|---------|--------|-------|
| `@heybeaux/lattice-core` | v0.3.0 | ✅ Published | State Contracts, Circuit Breakers, Pipeline, Redaction, Events, Compliance, ConsensusReducer, L0 Policy Rules, Config, OTel |
| `@heybeaux/lattice-provider-openai` | v0.2.0 | ✅ Published | L2 embeddings + L3 LLM-as-judge via OpenAI, timeout support |
| `@heybeaux/lattice-adapter-mastra` | v0.2.0 | ✅ Published | wrapMastraStep() + createLatticePipeline() |
| `@heybeaux/lattice-adapter-parliament` | v0.3.0 | ✅ Published | Parliament reasoning integration |
| `lattice-langgraph` | 0.2.1 | ✅ Published | [PyPI](https://pypi.org/project/lattice-langgraph/) — wrap_node() + LatticeMiddleware, 13 tests |
| `lattice-crewai` | 0.2.1 | ✅ Published | [PyPI](https://pypi.org/project/lattice-crewai/) — wrap_task() + LatticeCrewMiddleware, 15 tests |

## Benchmarks

Two benchmarks ship with the repo — run them yourself with real API keys.

**Real benchmark** (`benchmark/run-real.ts`) — 13 test scenarios with actual OpenAI API calls (gpt-4o-mini):
- Structural failures, semantic validation (hallucinations, off-topic, contradictions), false-positive rejection, and redaction
- Run: `npx tsx benchmark/run-real.ts` (requires `OPENAI_API_KEY`)

**Synthetic benchmark** (`benchmark/run.ts`) — 16 fault-injection scenarios, zero dependencies:
- L1 structural detection: 100% (3/3)
- Redaction: 100% (3/3)
- L3 semantic scenarios included but require API key to evaluate
- Run: `npx tsx benchmark/run.ts`

[Full benchmark code →](./benchmark/run-real.ts) · [Synthetic benchmark →](./benchmark/README.md)

## What's Honest About v0.3

**What works well:**
- L1 structural validation catches agent crashes and envelope violations deterministically
- L3 semantic validation catches hallucinations, contradictions, and off-topic content via LLM-as-judge
- L0 deterministic policy rules (JSONPath evaluator, 8 rule kinds, fuzz-tested) for zero-LLM governance
- Redaction scrubs API keys, tokens, emails, phone numbers before logging or external calls
- Pipeline builder composes agents with built-in coordination, retry/abort/degrade recovery, and parallel branches
- Full audit trail: every handoff produces an immutable State Contract
- Persistent circuit breaker state survives process restarts
- Auto-discovery config system (JSON, YAML, TOML, ESM/CJS)
- Structured observability via JSON-line or OpenTelemetry exporters
- Framework adapters for LangGraph, CrewAI, Mastra, and Parliament

**What's limited:**
- L3 adds ~1-2s latency per handoff (LLM round-trip) — only use on critical steps
- L2 embedding similarity has an LRU cache and rate limiter but no published benchmark results yet
- Dashboard exists (`dashboard/`) — React app for JSONL audit log inspection with demo data, run comparison, and CSV/compliance exports. Needs a live integration with JSON-line/OTel streams.
- No production track record at scale — the Forge integration plan exists but hasn't shipped
- Python adapters (LangGraph, CrewAI) are less mature than the TypeScript core

**What's not a product (yet):**
- This is a library, not a platform. You wire it up yourself.
- No managed service, no SaaS, no "Lattice Cloud"
- No drop-in replacement for LangGraph/CrewAI — it's a coordination layer that sits alongside them

## Quick Start

```bash
npm install @heybeaux/lattice-core @heybeaux/lattice-provider-openai
```

```typescript
import { pipeline, HandoffFailure } from '@heybeaux/lattice-core';
import { createOpenAIJudgeProvider } from '@heybeaux/lattice-provider-openai';

const p = pipeline()
  .agent('researcher', researchFn, { breaker: { tier: 'L1+L3' } })
  .agent('writer', writeFn, { breaker: { tier: 'L1' } })
  .onReject('retry', { maxRetries: 2 })
  .build();

// Inject L3 judge
const judge = createOpenAIJudgeProvider({ apiKey: process.env.OPENAI_API_KEY });
// (In practice, inject via wrapAgent or Pipeline config)

try {
  const result = await p.execute({ query: 'AI coordination' });
} catch (err) {
  if (err instanceof HandoffFailure) {
    console.error('Caught:', err.validation.reason);
    console.error('Contract:', err.contract); // full audit trail
  }
}
```

## v0.4.0 — Hardening & Observability

> All v0.4 features are opt-in. All v0.3 code works unchanged.

### Persistent Circuit State

Keep circuit breaker state across process restarts using `JsonFileBackend`:

```typescript
import { CircuitBreaker } from '@heybeaux/lattice-core';
import { JsonFileBackend } from '@heybeaux/lattice-core/dist/breaker/persistence.js';

const backend = new JsonFileBackend('./circuit-state.json');
const breaker = new CircuitBreaker({
  id: 'my-breaker',
  failureThreshold: 3,
  persistence: backend,
});

// Restore state from disk on startup
await breaker.restoreState();
```

State survives restarts — if the circuit was open when the process exited, it will still be open when it comes back. The backend uses atomic writes (temp → rename) to prevent corruption.

See [examples/persistent-breaker.ts](./examples/persistent-breaker.ts) and [docs/config.md](./docs/config.md).

### L2 Embedding

Add semantic consistency checks to `TieredCircuitBreaker` using OpenAI embeddings:

```typescript
import { TieredCircuitBreaker } from '@heybeaux/lattice-core';
import { createOpenAIEmbeddingProvider } from '@heybeaux/lattice-provider-openai';

const breaker = new TieredCircuitBreaker({ tier: 'L1+L2' });
breaker.setEmbeddingProvider(
  createOpenAIEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY })
);

const result = await breaker.validate(contract);
// L1: schema check (<1ms) → L2: cosine similarity (50-200ms, batched)
```

The embedding provider includes an LRU cache (1024 entries) and token-bucket rate limiter (60 req/min) to avoid hammering the API.

See [examples/l2-embedding.ts](./examples/l2-embedding.ts).

### Structured Observability

Export all Lattice events as newline-delimited JSON or OpenTelemetry spans:

```typescript
import { JsonLineExporter, OtelExporter, globalEmitter } from '@heybeaux/lattice-core';

// JSON-line log (always available, no extra deps)
const jsonExporter = new JsonLineExporter({ outputPath: './lattice-events.jsonl' });
jsonExporter.attach(globalEmitter);

// OpenTelemetry via OTLP/HTTP (peer deps: @opentelemetry/*)
const otelExporter = new OtelExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent-system',
});
otelExporter.attach(globalEmitter);
```

OTel SDK is an optional peer dependency. If not installed, `OtelExporter` tracks spans internally without OTLP export — zero errors, graceful degradation.

See [examples/observability.ts](./examples/observability.ts) and [docs/observability.md](./docs/observability.md).

### Config File

Place `lattice.config.json` in your project root for zero-code configuration:

```json
{
  "circuitBreaker": {
    "tier": "L1+L2",
    "failureThreshold": 5,
    "persist": { "path": "./circuit-state.json" }
  },
  "observability": {
    "jsonLinePath": "./logs/lattice.jsonl"
  }
}
```

Lattice auto-discovers `lattice.config.json`, `.yaml`, `.toml`, `.mjs`, or `.cjs` from your working directory.

```typescript
import { createConfig } from '@heybeaux/lattice-core';

// Auto-discovers lattice.config.json from cwd
const config = createConfig();

// Or async for YAML/TOML/ESM formats
const config = await createConfigAsync();
```

See [docs/config.md](./docs/config.md) for the full schema reference.

### Error Boundaries

Typed errors for provider failures, with timeout and rate-limit wrappers:

```typescript
import {
  withTimeout,
  withRateLimit,
  ProviderTimeoutError,
  ProviderRateLimitError,
} from '@heybeaux/lattice-core';

// Timeout after 5s
const result = await withTimeout(() => provider.embed(text), 5000, 'openai');

// Auto-retry on 429 with exponential backoff
const result = await withRateLimit(() => provider.embed(text), 'openai');

// Catch specific errors
try {
  await breaker.validate(contract);
} catch (err) {
  if (err instanceof ProviderTimeoutError) {
    console.error(`${err.provider} timed out after ${err.timeoutMs}ms`);
  } else if (err instanceof ProviderRateLimitError) {
    console.error(`Rate limited. Retry after ${err.retryAfterMs}ms`);
  }
}
```

Use `onReject: 'degrade'` in `TieredCircuitBreaker` to treat provider errors as graceful degradation rather than failures:

```typescript
const breaker = new TieredCircuitBreaker({
  tier: 'L1+L2',
  onReject: 'degrade',  // L2 timeout → pass through (flagged), not failure
});
```

See [examples/error-boundaries.ts](./examples/error-boundaries.ts) and [docs/error-boundaries.md](./docs/error-boundaries.md).

## Examples

- [**Quick Start Demo**](./examples/quick-start/demo.ts) — 4 scenarios: healthy pipeline, circuit breaker, redaction, degrade mode
- [**Persistent Circuit Breaker**](./examples/persistent-breaker.ts) — `JsonFileBackend` across restarts
- [**L2 Embedding**](./examples/l2-embedding.ts) — `TieredCircuitBreaker` with OpenAI embeddings
- [**Observability**](./examples/observability.ts) — `JsonLineExporter` + `OtelExporter` setup
- [**Error Boundaries**](./examples/error-boundaries.ts) — `withTimeout`, degrade mode
- [**Real Benchmark**](./benchmark/run-real.ts) — 13 scenarios with actual OpenAI API calls
- [**Synthetic Benchmark**](./benchmark/run.ts) — 16 fault-injection scenarios, zero deps
- [**Forge Integration Plan**](./FORGE_INTEGRATION.md) — How to wrap Forge's LinkedIn pipeline

## Documentation

- [**THESIS.md**](./THESIS.md) — Research, architecture, and positioning
- [**Config Reference**](./docs/config.md) — `lattice.config.json` schema, all formats
- [**Observability**](./docs/observability.md) — `JsonLineExporter`, `OtelExporter`, span reference
- [**Error Boundaries**](./docs/error-boundaries.md) — Provider errors and graceful degradation
- [**Migration v0.3 → v0.4**](./docs/migration-v0.3-to-v0.4.md) — Zero breaking changes, opt-in features
- [**OpenSpec Proposal**](./openspec/changes/v0-1-state-contracts-and-circuit-breakers/proposal.md) — v0.1 scope and requirements
- [**Marketing Site**](https://heybeaux.github.io/lattice/)

## Roadmap

| Priority | Task | Status |
|----------|------|--------|
| 🔥 | Forge integration (real traces benchmark) | Plan written, not yet wired |
| ✅ | L0 deterministic policy rules | **Shipped** — 8 rule kinds, JSONPath, fuzz-tested |
| ✅ | LangGraph + CrewAI adapters (Python) | **Published** — PyPI: `lattice-langgraph`, `lattice-crewai` |
| ✅ | ConsensusReducer | **Built** — majority vote, conflict flagging, embedding similarity |
| ✅ | `parallel()` + `join()` combinators | **Built** — fan-out/fan-in for DAGs |
| ✅ | Persistent circuit breaker state | **Built** — `JsonFileBackend`, atomic writes |
| ✅ | Config auto-discovery | **Built** — JSON, YAML, TOML, ESM/CJS |
| ✅ | OTel + JSON-line observability | **Built** — `OtelExporter`, `JsonLineExporter` |
| ✅ | Error boundaries | **Built** — typed provider errors, `withTimeout`, `withRateLimit` |
| ✅ | adapter-parliament | **Shipped** — v0.3.0 |
| 🟡 | L2 embedding real benchmark | Provider exists, benchmark pending |
| 🟡 | Observability dashboard — live stream integration | Dashboard built, needs real-time JSONL/OTel stream connection |
| 🟢 | LangGraph adapter (TypeScript) | Stub in tree, needs work |

## Ecosystem

Lattice sits between agent frameworks and agents:

```
┌─────────────┐     ┌──────────┐     ┌─────────┐
│ LangGraph   │────▶│ Lattice  │────▶│ Agents  │
│ CrewAI      │────▶│ (coord)  │────▶│ (any)   │
│ Mastra      │────▶│          │────▶│         │
│ Parliament  │────▶│          │────▶│         │
│ Custom      │────▶│          │────▶│         │
└─────────────┘     └──────────┘     └─────────┘
                         │
                    ┌────▼─────┐
                    │ ACR      │ capabilities
                    │ Engram   │ memory
                    │ Parliament│ reasoning
                    └──────────
```

## License

MIT

---

*Built by the [heybeaux](https://github.com/heybeaux) team. Because scaling agents requires scaling coordination.*

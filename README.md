# Lattice

**Coordination infrastructure for multi-agent AI systems.**

[![npm](https://img.shields.io/npm/v/@heybeaux/lattice-core.svg)](https://www.npmjs.com/package/@heybeaux/lattice-core)
[![npm](https://img.shields.io/npm/v/@heybeaux/lattice-provider-openai.svg)](https://www.npmjs.com/package/@heybeaux/lattice-provider-openai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Benchmark](https://img.shields.io/badge/benchmark-85%25_accuracy-blue)](https://github.com/heybeaux/lattice/tree/main/benchmark)

> Like threading libraries for concurrent programming — but for AI agents.

Multi-agent AI systems fail at high rates due to **structural coordination failures**, not model quality. Lattice provides the primitives — State Contracts, Circuit Breakers, Pipeline orchestration — that make multi-agent systems reliable.

## Status

| Package | Version | Status | Notes |
|---------|---------|--------|-------|
| `@heybeaux/lattice-core` | v0.1.0 | ✅ Published | State Contracts, Circuit Breakers, Pipeline, Redaction, Events, ConsensusReducer, parallel()/join() |
| `@heybeaux/lattice-provider-openai` | v0.1.0 | ✅ Published | L2 embeddings + L3 LLM-as-judge via OpenAI |
| `@heybeaux/lattice-adapter-mastra` | v0.1.0 | ✅ Published | wrapMastraStep() + createLatticePipeline() |
| `lattice-langgraph` | — | ✅ Merged | Python — wrap_node() + LatticeMiddleware, 13 tests |

## Real Benchmark Results (May 8, 2026)

13 test scenarios with **actual OpenAI API calls** (gpt-4o-mini, no projections):

| Metric | Result |
|--------|--------|
| **Overall accuracy** | **85%** (11/13 correct) |
| **L3 semantic detection** | **100%** (6/6 hallucinations caught) |
| **False positive rate** | **0%** (4/4 correct outputs passed) |
| **False negatives** | **0** |
| **Avg latency (L1+L3)** | 1,174ms (includes LLM round-trip) |

Run it yourself: `npx tsx benchmark/run-real.ts`

**What L3 caught every time:**
- Empty output → confidence 1.00
- Hallucinated facts (invented dates, events) → confidence 0.90
- Invented citations → confidence 0.90
- Completely off-topic content → confidence 0.00
- Contradictory output → confidence 0.00
- Partial/incomplete answers → confidence 0.90

**What L3 correctly passed:**
- Valid summary → confidence 1.00
- Valid extraction → confidence 0.90
- Valid formatted report → confidence 0.90
- Short correct answer → confidence 1.00

[Full benchmark code →](./benchmark/run-real.ts)

## What's Honest About v0.1

**What works well:**
- L1 structural validation catches agent crashes and envelope violations 100% of the time
- L3 semantic validation (with OpenAI provider) catches hallucinations, wrong content, and empty outputs 100% of the time
- Zero false positives — correct outputs always pass
- Redaction scrubs API keys, tokens, emails, phone numbers before logging
- Pipeline builder composes agents with built-in coordination
- Full audit trail: every handoff produces a State Contract

**What's limited:**
- L3 adds ~1-2s latency per handoff (LLM round-trip) — only use on critical steps
- L2 (embedding similarity) is untested with real data — provider exists but no benchmarks
- No framework adapters yet (LangGraph, CrewAI, AutoGen) — `wrapAgent()` works but requires manual wiring
- No Reducer primitives (distributed-state synthesis) — the Silo-Bench finding is acknowledged but not addressed in code
- No dashboard or observability UI — events go to EventEmitter but there's no built-in visualization
- No production track record — the Forge integration hasn't happened yet

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

## Examples

- [**Quick Start Demo**](./examples/quick-start/demo.ts) — 4 scenarios: healthy pipeline, circuit breaker, redaction, degrade mode
- [**Real Benchmark**](./benchmark/run-real.ts) — 13 fault scenarios with actual OpenAI API calls
- [**Forge Integration Plan**](./FORGE_INTEGRATION.md) — How to wrap Forge's LinkedIn pipeline

## Documentation

- [**THESIS.md**](./THESIS.md) — Research, architecture, and positioning
- [**OpenSpec Proposal**](./openspec/changes/v0-1-state-contracts-and-circuit-breakers/proposal.md) — v0.1 scope and requirements
- [**Marketing Site**](https://heybeaux.github.io/lattice/)

## Roadmap

| Priority | Task | Status |
|----------|------|--------|
| 🔥 | Forge integration (real traces benchmark) | In progress — Rook running 50 topics |
| ✅ | LangGraph adapter (Python) | **Merged** — wrap_node() + LatticeMiddleware, 13 tests |
| ✅ | ConsensusReducer (Silo-Bench synthesis fix) | **Built** — majority vote, conflict flagging |
| ✅ | `parallel()` + `join()` combinators | **Built** — fan-out/fan-in for DAGs |
| ✅ | JSON Schema IDL (canonical cross-language) | **Built** — generate:types script |
| ✅ | adapter-mastra npm publish | **Published** — optional peer dep |
| 🟡 | L2 real benchmark with Forge data | Waiting on Rook's run |
| 🟢 | Observability dashboard | Not started |

## Ecosystem

Lattice sits between agent frameworks and agents:

```
┌─────────────┐     ┌──────────┐     ┌─────────┐
│ LangGraph   │────▶│ Lattice  │────▶│ Agents  │
│ CrewAI      │────▶│ (coord)  │────▶│ (any)   │
│ AutoGen     │────▶│          │────▶│         │
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

# @heybeaux/lattice-core

**Coordination infrastructure for multi-agent AI systems.**

[![npm](https://img.shields.io/npm/v/@heybeaux/lattice-core.svg)](https://www.npmjs.com/package/@heybeaux/lattice-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Like threading libraries for concurrent programming — but for AI agents.

Multi-agent AI systems fail at high rates due to **structural coordination failures**, not model quality. Lattice provides the primitives — State Contracts, Circuit Breakers, Pipeline orchestration — that make multi-agent systems reliable.

## Quick Start

```bash
npm install @heybeaux/lattice-core
```

### State Contracts

Every agent handoff produces a State Contract — a typed envelope carrying full lineage:

```typescript
import { createContract, validateContract } from '@heybeaux/lattice-core';

const contract = createContract({
  fromAgent: 'researcher',
  toAgent: 'writer',
  inputs: { query: 'latest AI coordination papers' },
  outputs: { summary: 'MAST: 41-87% failure rates across frameworks...', citations: [...] },
  decisions: [{ type: 'action', rationale: 'chose synthesis approach' }],
  budget: { tokensUsed: 4200, callsMade: 2, wallClockMs: 1850 },
});

// L1 validation (deterministic, zero LLM calls)
const result = validateContract(contract);
console.log(result.valid); // true
```

### wrapAgent

Wrap any agent function to get coordination for free:

```typescript
import { wrapAgent, HandoffFailure } from '@heybeaux/lattice-core';

const researcher = wrapAgent(
  async (input: { query: string }) => {
    const results = await search(input.query);
    return { summary: results.map(r => r.summary).join('\n') };
  },
  {
    id: 'researcher',
    breaker: { tier: 'L1' }, // structural validation only
  },
);

try {
  const contract = await researcher({ query: 'AI coordination' });
  console.log(contract.outputs.payload.summary);
} catch (error) {
  if (error instanceof HandoffFailure) {
    console.error('Handoff rejected:', error.validation.reason);
  }
}
```

### Pipeline

Compose sequential agent handoffs with automatic coordination:

```typescript
import { pipeline, HandoffFailure } from '@heybeaux/lattice-core';

const pipeline_ = pipeline()
  .agent('researcher', researchFn, { breaker: { tier: 'L1+L3' } })
  .agent('writer', writeFn, { breaker: { tier: 'L1' } })
  .agent('editor', editFn, { breaker: { tier: 'L1' } })
  .onReject('retry', { maxRetries: 2 })
  .build();

const result = await pipeline_.execute({ query: '...' });

console.log(result.output);            // final editor output
console.log(result.contracts.length);   // 3 (one per agent)
console.log(result.hadRejected);        // any rejections?
console.log(result.totalDurationMs);    // total pipeline time

// All contracts share the same traceId
const traceId = result.contracts[0].traceId;
```

### Circuit Breaker Tiers

| Tier | What | Speed | Dependencies |
|------|------|-------|-------------|
| **L1** | JSON Schema validation | <200ms | None (built-in) |
| **L2** | Embedding similarity | ~500ms | User-injected `EmbeddingProvider` |
| **L3** | LLM-as-judge | 1-3s | User-injected `JudgeProvider` |

```typescript
import { TieredCircuitBreaker } from '@heybeaux/lattice-core';

const breaker = new TieredCircuitBreaker({
  tier: 'L1+L3',
  l3ConfidenceThreshold: 0.8,
  onReject: 'degrade', // continue with flagged contract
});

breaker.setJudgeProvider(myJudgeProvider);

const result = await breaker.validate(contract);
console.log(result.passed, result.confidence);
```

## API Reference

| Export | Purpose |
|--------|---------|
| `createContract()` | Factory for State Contracts |
| `validateContract()` | L1 schema validation |
| `SchemaValidator` | Reusable schema validator instance |
| `wrapAgent()` | Wrap agent functions with coordination |
| `HandoffFailure` | Error thrown on validation rejection |
| `pipeline()` | Build sequential agent pipelines |
| `TieredCircuitBreaker` | Multi-tier validation with state machine |
| `CircuitBreaker` | Classic closed/open/half-open state machine |
| `EventEmitter` / `globalEmitter` | Typed coordination events |
| `redactContract()` | PII scrubbing for logged contracts |

## Examples & Benchmark

- [**Quick Start Demo**](./examples/quick-start/demo.ts) — Run `npx tsx examples/quick-start/demo.ts` to see Lattice in action
- [**Synthetic Benchmark**](./benchmark/README.md) — 16 fault scenarios, 75% projected detection with L1+L3
- [**Forge Integration**](./FORGE_INTEGRATION.md) — Wrapping Forge's LinkedIn pipeline with Lattice

## Documentation

- [**THESIS.md**](https://github.com/heybeaux/lattice/blob/main/THESIS.md) — Research, architecture, and positioning
- [**OpenSpec Proposal**](https://github.com/heybeaux/lattice/blob/main/openspec/changes/v0-1-state-contracts-and-circuit-breakers/proposal.md) — v0.1 scope and requirements

## Part of the heybeaux Ecosystem

| Project | Purpose |
|---------|---------|
| [ACR](https://github.com/heybeaux/acr) | What agents CAN do (capability resolution) |
| [Engram](https://github.com/heybeaux/engram) | What agents DID (episodic memory) |
| [LeWM](https://github.com/heybeaux/le-wm) | What WILL happen (prediction) |
| **Lattice** | How agents WORK TOGETHER (coordination) |
| [AWM](https://github.com/heybeaux/awm) | What agents WILL do (pipeline prediction) |

## License

MIT

---

*Built by the heybeaux team. Because scaling agents requires scaling coordination.*

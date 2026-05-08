# Proposal: Lattice v0.1 — State Contracts and Circuit Breakers

## Intent

Multi-agent AI systems fail at high rates in production due to structural coordination failures — not model quality. In our internal analysis of 200+ Forge pipeline traces, we identified:

1. **Context loss at handoffs** (~44% of failures): the downstream agent doesn't know what the upstream agent did, why, or what assumptions it made
2. **Plausible-but-wrong outputs** (~24% of failures): the system returns 200 OK with garbage, and no structural check catches it

These findings are consistent with published research: UC Berkeley MAST (1,600+ traces, 41–87% failure rates across 7 frameworks, NeurIPS 2025 Spotlight), Silo-Bench (agents communicate correctly but fail to synthesize distributed state, arXiv:2603.01045), and SEMAP (structured protocols reduce coordination failures by 69.6%, arXiv:2510.12120). We commit to publishing our Forge trace analysis methodology and labeling rubric alongside v0.1.

Lattice v0.1 introduces two primitives that solve these specific problems:

- **State Contracts**: typed envelopes that carry inputs, decisions, outputs, constraints, and assumptions between every agent handoff
- **Semantic Circuit Breakers**: tiered validation gates that run between agents, checking output correctness before it propagates downstream

## Scope

### In scope (v0.1)

- State Contract data model (JSON Schema + TypeScript types)
- `wrapAgent()` helper for integrating existing agents
- Tiered Circuit Breaker with three levels:
  - L1: Deterministic schema/structural validation (fast, default)
  - L2: Embedding similarity / semantic consistency check (opt-in)
  - L3: LLM-as-judge semantic validation (high-stakes, with confidence threshold + human escalation fallback)
- `Pipeline` builder for composing sequential agent handoffs
- In-process only (no network service)
- JSON logging with PII redaction utility (scrubs sensitive data before logging)
- OpenTelemetry event emission
- TypeScript, MIT-licensed, zero runtime dependencies for L1 validation (ajv only); L2 and L3 are opt-in and require user-injected providers via `EmbeddingProvider` and `JudgeProvider` interfaces

### Out of scope (deferred)

- Reducer primitives (v0.2) — distributed-state synthesis
- Deadlock detection (v0.2) — livelock, circular waits, stale handoffs
- Event bus (v0.2) — pub/sub coordination
- Parallel/DAG pipeline execution (v0.2) — v0.1 is sequential-only; schema includes `parentIds: string[]` for forward compatibility
- Streaming output validation (v0.2)
- Networked/remote coordination (v1.0)
- Framework adapters (LangGraph, AutoGen, CrewAI) — these will be separate `@lattice/adapter-*` packages

## Approach

A lightweight TypeScript library that wraps existing agents with coordination infrastructure. Agents don't need to know about Lattice — they continue operating normally. Lattice intercepts inputs and outputs at handoff boundaries, attaching State Contracts and running Circuit Breaker validation.

The first validation target is the heybeaux/Forge research→draft pipeline, where we'll replay 200 existing traces to quantify handoff failure rate reduction.

## Success Criteria

- ≥50% reduction in handoff failures on Forge trace replay (200 traces)
- ≥40% fault detection rate on synthetic 4-agent pipeline with injected faults (second validation target to avoid Forge overfitting)
- Zero runtime dependencies for L1 validation (ajv only); L2/L3 require user-injected providers
- `<200ms` p95 overhead per L1 validation (deterministic only)
- `<500ms` p95 overhead per L2 validation (with user-supplied embedding provider)
- L3 hard timeout with configurable cap (default 5s)
- Clean TypeScript types — every exported API is fully typed
- All public APIs documented with JSDoc + examples

## Resolved Decisions

1. **JSON Schema validator**: `ajv` — fastest, well-maintained, widely adopted
2. **L2/L3 dependency model**: User-injected providers only. `EmbeddingProvider` interface for L2, `JudgeProvider` interface for L3. Lattice ships the interfaces and example implementations, but no default LLM calls at runtime.
3. **State Contract versioning**: `schemaVersion` (semver string) is mandatory in every contract envelope from v0.1. Backward-read compatibility within a major version; forward-incompatible contracts are rejected with a clear error.

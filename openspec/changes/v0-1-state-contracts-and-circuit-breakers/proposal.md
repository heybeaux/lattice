# Proposal: Lattice v0.1 — State Contracts and Circuit Breakers

## Intent

Multi-agent AI systems fail 41–87% of the time in production due to structural coordination failures — not model quality. The two most critical failure modes are:

1. **Context loss at handoffs** (~44% of failures): the downstream agent doesn't know what the upstream agent did, why, or what assumptions it made
2. **Plausible-but-wrong outputs** (~24% of failures): the system returns 200 OK with garbage, and no structural check catches it

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
- JSON logging + OpenTelemetry event emission
- TypeScript, MIT-licensed, zero runtime dependencies (except JSON Schema validator)

### Out of scope (deferred)

- Reducer primitives (v0.2) — distributed-state synthesis
- Deadlock detection (v0.2) — livelock, circular waits, stale handoffs
- Event bus (v0.2) — pub/sub coordination
- Networked/remote coordination (v1.0)
- Framework adapters (LangGraph, AutoGen, CrewAI) — these will be separate `@lattice/adapter-*` packages

## Approach

A lightweight TypeScript library that wraps existing agents with coordination infrastructure. Agents don't need to know about Lattice — they continue operating normally. Lattice intercepts inputs and outputs at handoff boundaries, attaching State Contracts and running Circuit Breaker validation.

The first validation target is the heybeaux/Forge research→draft pipeline, where we'll replay 200 existing traces to quantify handoff failure rate reduction.

## Success Criteria

- ≥50% reduction in handoff failures on Forge trace replay (200 traces)
- Zero new dependencies for consuming applications (JSON Schema validator is the only runtime dep)
- `<200ms` overhead per L1 validation (deterministic only)
- Clean TypeScript types — every exported API is fully typed
- All public APIs documented with JSDoc + examples

## Open Questions

1. **JSON Schema validator choice** — `ajv` (fastest) vs `@cfworker/json-schema` (smaller, browser-safe)?
2. **LLM-as-judge model routing** — should Circuit Breaker L3 accept a model selector, or use a default?
3. **State Contract versioning** — embed semantic version in every contract envelope for forward/backward compatibility?

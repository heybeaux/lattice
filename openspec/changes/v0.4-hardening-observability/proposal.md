# Proposal: Lattice v0.4.0 — Hardening & Observability

## Intent

Lattice v0.3.0 proved the core thesis: coordination primitives (State Contracts, Circuit Breakers, ConsensusReducer) make multi-agent systems reliable with near-zero overhead (~15ms per wrap, 0.25% of wall-clock).

v0.4.0 hardens Lattice for production use: persistent circuit state that survives restarts, structured observability with OpenTelemetry, a config file system so teams don't wire everything in code, L2 embedding validation out of the box, and graceful degradation when providers fail.

This release is additive only — zero breaking changes.

## Scope

### In scope (v0.4.0)

1. **Persistent circuit state** — CircuitBreaker state persists across process restarts via JSON or SQLite backend
2. **L2 embedding hook** — `EmbeddingProvider` interface + default cosine-sim comparator built into core
3. **Structured observability** — JSON-line export + OpenTelemetry span exporter
4. **Developer DX** — `lattice.config.{js,yaml,toml}` with validation and auto-discovery
5. **Error boundaries** — graceful degradation when L2/L3 providers timeout, rate-limit, or return malformed JSON

### Out of scope (deferred)

- Framework adapters beyond existing Parliament/Mastra/LangGraph/CrewAI
- Formal spec v1 (JSON Schema 2020-12 migration)
- Enterprise audit features (signed attestations, SOC 2 reports)
- Performance SLAs and backpressure controls
- Public benchmark suite

## Approach

All features are additive — existing code paths continue to work unchanged. New capabilities are opt-in:

- Persistent state: `CircuitBreaker({ persist: { path: './state.json' } })`
- Observability: `globalEmitter.setExporter(new OtlpSpanExporter())`
- Config file: auto-discovered from `process.cwd()` or explicit `--config` flag
- Error boundaries: `CircuitBreaker({ fallback: 'degrade', timeout: 5000 })`
- L2 embedding: `TieredCircuitBreaker({ tier: 'L1+L2' })` with built-in OpenAI provider

## Success Criteria

- CircuitBreaker state survives process restart and resumes correctly
- L2 validation produces meaningful similarity scores (>0.85 for agreeing models)
- OpenTelemetry spans exported with full Lattice context (traceId, tier, latency)
- Config file reduces boilerplate by ≥50% compared to programmatic config
- Provider failures (timeout, rate-limit, malformed) degrade gracefully without crashing
- Zero breaking changes — all v0.3.0 code works without modification
- All tests pass on Node 20, 22, 24

## Open Questions

1. **SQLite vs JSON for persistence?** JSON is simpler, SQLite is more robust. Default to JSON, offer SQLite as optional.
2. **Which OTel protocol?** OTLP/HTTP is standard, OTLP/gRPC is faster. Default HTTP for simplicity.
3. **Config file format priority?** YAML for readability, JS for programmatic flexibility, TOML for TOML fans.

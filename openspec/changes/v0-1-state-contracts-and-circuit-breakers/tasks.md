# Tasks: Lattice v0.1 — State Contracts and Circuit Breakers

## 1. Project Setup
- [ ] 1.1 Initialize TypeScript monorepo with pnpm workspaces
- [ ] 1.2 Configure `@heybeaux/lattice-core` package (package.json, tsconfig, vitest, tsup)
- [ ] 1.3 Set up ESLint + Prettier + commit lint
- [ ] 1.4 Add JSON Schema for State Contract (`schema/contract.schema.json`)
- [ ] 1.5 Publish initial package to npm (scoped: `@heybeaux/lattice-core`)

## 2. State Contract
- [ ] 2.1 Define TypeScript types for full State Contract envelope
- [ ] 2.2 Implement `createContract()` factory with ULID generation
- [ ] 2.3 Implement `validateContract()` against JSON Schema (ajv)
- [ ] 2.4 Implement `Contract` class with `Object.freeze()` immutability
- [ ] 2.5 Implement trace ID propagation (`TraceContext`)
- [ ] 2.6 Implement `ContractPayload<T>` generic type for opaque payloads
- [ ] 2.7 Implement version detection and mismatch handling
- [ ] 2.8 Write unit tests for all contract operations
- [ ] 2.9 Write property-based tests for serialization round-trips

## 3. Circuit Breaker
- [ ] 3.1 Implement Circuit Breaker state machine (closed → open → half-open)
- [ ] 3.2 Implement L1 structural validation (JSON Schema via ajv)
- [ ] 3.3 Implement L2 semantic consistency check (embedding similarity)
- [ ] 3.4 Implement L3 LLM-as-judge validation with confidence scoring
- [ ] 3.5 Implement per-handoff breaker configuration
- [ ] 3.6 Implement budget enforcement (token/call/time limits)
- [ ] 3.7 Implement circuit breaker metrics (duration, results, state changes)
- [ ] 3.8 Write unit tests for all state transitions
- [ ] 3.9 Write integration tests for tiered validation pipeline

## 4. wrapAgent() Helper
- [ ] 4.1 Implement `wrapAgent()` that wraps any `fn(input) → output` function
- [ ] 4.2 Ensure wrapped agent returns `StateContract` not raw output
- [ ] 4.3 Support async and sync agent functions
- [ ] 4.4 Support budget configuration per wrapped agent
- [ ] 4.5 Support circuit breaker configuration per wrapped agent
- [ ] 4.6 Write unit tests for wrapped agent behavior

## 5. Pipeline Builder
- [ ] 5.1 Implement `pipeline()` fluent builder API
- [ ] 5.2 Implement `.agent(name, fn, config)` chain method
- [ ] 5.3 Implement sequential execution with contract handoffs
- [ ] 5.4 Implement abort behavior on validation failure
- [ ] 5.5 Implement retry behavior with max retries and enriched context
- [ ] 5.6 Implement fallback behavior with registered fallback outputs
- [ ] 5.7 Implement degrade behavior (continue with flagged contracts)
- [ ] 5.8 Write unit tests for pipeline execution flows
- [ ] 5.9 Write integration test for multi-agent pipeline

## 5b. Contract Redaction
- [ ] 5b.1 Implement `redactContract()` utility with schema-based field classification
- [ ] 5b.2 Support `[REDACTED]` placeholder for sensitive values
- [ ] 5b.3 Integrate redaction into logging pipeline (automatic before write)
- [ ] 5b.4 Write tests for redaction coverage

## 6. Event Emission
- [ ] 6.1 Implement local EventEmitter with typed events
- [ ] 6.2 Implement OpenTelemetry span creation for contract lifecycle
- [ ] 6.3 Emit `contract:emitted` events
- [ ] 6.4 Emit `contract:validated` / `contract:rejected` events
- [ ] 6.5 Emit `circuit:opened` / `circuit:closed` / `circuit:half-open` events
- [ ] 6.6 Emit `pipeline:started` / `pipeline:completed` / `pipeline:aborted` events
- [ ] 6.7 Write tests for event emission

## 7. Documentation
- [ ] 7.1 Write README with quick start guide
- [ ] 7.2 Document all public APIs with JSDoc
- [ ] 7.3 Write usage examples:
  - [ ] 7.3.1 Two-agent sequential pipeline
  - [ ] 7.3.2 Agent with L3 validation + human escalation
  - [ ] 7.3.3 Pipeline with retry on failure
  - [ ] 7.3.4 Zero-LLM (L1-only) deployment
- [ ] 7.4 Publish API reference (typedoc)

## 8. Validation & Benchmarking
- [ ] 8.1 Integrate with Forge research→draft pipeline
- [ ] 8.2 Replay 200 existing traces with Lattice instrumentation
- [ ] 8.3 Measure baseline handoff failure rate vs. Lattice-protected rate
- [ ] 8.4 Build synthetic 4-agent pipeline (summarize → extract → validate → format) with injected faults
- [ ] 8.5 Run synthetic pipeline with 50+ injected fault scenarios
- [ ] 8.6 Measure fault detection rate (target: ≥40%)
- [ ] 8.7 Benchmark L1 overhead per validation (<200ms p95 target)
- [ ] 8.8 Benchmark L2 overhead per validation (<500ms p95 target)
- [ ] 8.9 Benchmark L3 overhead with timeout enforcement
- [ ] 8.10 Publish benchmark results + Forge trace analysis methodology

## 9. CI/CD
- [ ] 9.1 Set up GitHub Actions for test, lint, build
- [ ] 9.2 Add coverage reporting (target: ≥90% line coverage)
- [ ] 9.3 Configure npm publish workflow (on tag)
- [ ] 9.4 Add dependabot for dependency updates

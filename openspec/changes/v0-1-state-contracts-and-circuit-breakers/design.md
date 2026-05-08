# Design: Lattice v0.1 — State Contracts and Circuit Breakers

## Technical Approach

### Package Structure

```
packages/
├── core/              # @lattice/core — zero external dependencies
│   ├── src/
│   │   ├── contract.ts        # StateContract type + factory
│   │   ├── schema/            # JSON Schema definitions
│   │   │   └── contract.schema.json
│   │   ├── breaker/           # CircuitBreaker implementation
│   │   │   ├── types.ts
│   │   │   ├── breaker.ts     # State machine (closed/open/half-open)
│   │   │   ├── tiers.ts       # L1/L2/L3 validation tiers
│   │   │   └── metrics.ts     # Observability helpers
│   │   ├── pipeline/          # Pipeline builder
│   │   │   ├── builder.ts
│   │   │   └── executor.ts
│   │   ├── wrapper/           # wrapAgent helper
│   │   │   └── wrap-agent.ts
│   │   ├── events/            # EventEmitter + OTel integration
│   │   │   └── emitter.ts
│   │   └── index.ts           # Public API surface
│   └── package.json
└── ... (adapter packages in future releases)
```

### Core Types

```typescript
// State Contract envelope
interface StateContract<TIn = unknown, TOut = unknown> {
  id: string;              // ULID
  version: string;         // Semver, e.g. "0.1.0"
  traceId: string;         // Cross-contract correlation
  fromAgent: string;       // Producer identifier
  toAgent: string | null;  // Consumer identifier (null for fan-out)
  timestamp: string;       // ISO 8601
  inputs: ContractPayload<TIn>;
  decisions: Decision[];
  outputs: ContractPayload<TOut>;
  constraints: Constraint[];
  assumptions: Assumption[];
  budget: BudgetRecord;
  metadata: Record<string, unknown>;
}

// Circuit Breaker configuration
interface CircuitBreakerConfig {
  tier: 'L1' | 'L1+L2' | 'L1+L3' | 'L1+L2+L3';
  l2Threshold?: number;           // Embedding similarity threshold (default 0.7)
  l3Model?: string;               // Model for LLM-as-judge (default from auth config)
  l3ConfidenceThreshold?: number; // Confidence below which escalation triggers (default 0.7)
  failureThreshold?: number;      // Consecutive failures before opening (default 3)
  recoveryTimeoutMs?: number;     // Time before half-open (default 60000)
  onEscalation?: EscalationHandler;
  budgetEnforcement?: BudgetConfig;
}

// Pipeline builder API
function pipeline(): PipelineBuilder;
// Usage:
//   pipeline()
//     .agent('researcher', researcherFn, { breaker: { tier: 'L1+L3' } })
//     .agent('writer', writerFn, { breaker: { tier: 'L1' } })
//     .build()
//     .execute(input)
```

### Key Design Decisions

#### 1. Tiered Dependencies

- **L1 validation**: Zero external dependencies except `ajv` (JSON Schema validator).
- **L2 validation**: Requires user-injected `EmbeddingProvider` interface. Lattice ships the interface and an example OpenAI implementation, but no embedding model at runtime.
- **L3 validation**: Requires user-injected `JudgeProvider` interface. Lattice ships the interface and an example LLM implementation, but no default LLM calls.

This means L1 works out of the box with zero API keys. L2 and L3 are opt-in for users who want semantic validation.

#### 2. wrapAgent() — The Integration Point

Agents don't need to know about Lattice. The `wrapAgent()` helper wraps any function-based agent:

```typescript
const latticeAgent = wrapAgent(myAgent, {
  id: 'my-agent',
  breaker: { tier: 'L1+L3' },
  budget: { maxTokens: 10000 },
});

const contract = await latticeAgent(input);
// Returns a StateContract, not the raw output
```

This makes adoption trivial — wrap existing agents, compose into pipelines, get coordination for free.

#### 3. Circuit Breaker State Machine

The breaker implements the classic circuit breaker pattern (Nygaard) with states:
- **Closed** → normal validation
- **Open** → immediate rejection (after N consecutive failures)
- **Half-Open** → single test attempt (after recovery timeout)

State transitions are atomic and per-handoff (identified by `fromAgent → toAgent` pair).

#### 4. Tiered Validation Pipeline

Validation runs sequentially through enabled tiers:
```
L1 (structural) ──fail──▶ reject immediately
    │pass
    ▼
L2 (semantic) ──fail──▶ reject (if enabled)
    │pass
    ▼
L3 (LLM judge) ──uncertain + low confidence──▶ escalate (if enabled)
    │pass
    ▼
  contract accepted
```

Each tier is independent and can be enabled/disabled per-handoff.

#### 5. Event Emission

Two parallel event systems:
- **Local EventEmitter** — synchronous, in-process, for application-level handling
- **OpenTelemetry** — async, exportable, for observability platforms

Events:
```
contract:emitted
contract:validated
contract:rejected
circuit:opened
circuit:closed
circuit:half-open
pipeline:started
pipeline:completed
pipeline:aborted
```

#### 5b. Redaction Utility

State Contracts contain agent inputs, outputs, and decisions — which may include PII, API keys, or other sensitive data. Before any contract is logged or exported, the `redactContract()` utility runs:

- Fields are classified via the JSON Schema (`sensitivity: 'high'` annotation)
- Sensitive values are replaced with `[REDACTED]` placeholder
- Contract structure is preserved (field names remain for audit purposes)
- Redaction is applied automatically by the logging pipeline

```typescript
const redacted = redactContract(contract, { sensitivityLevel: 'high' });
// All fields marked as sensitive are replaced with [REDACTED]
```

#### 6. Immutability

State Contracts are frozen with `Object.freeze()` after emission. Any modification attempt creates a new contract instance (copy-on-write). This ensures audit trail integrity.

### What We're Not Building (Yet)

| Deferred | Why |
|----------|-----|
| Reducer primitives | Requires fan-out topology understanding — v0.2 |
| Deadlock detection | Requires cycle detection across agent graph — v0.2 |
| Event bus (pub/sub) | Networked coordination — v0.2 |
| Parallel/DAG execution | Sequential covers Forge use case; schema includes `parentIds` for forward compatibility — v0.2 |
| Streaming output validation | Mid-stream error prevention is complex — v0.2 |
| Framework adapters | Need to validate core API first — separate packages |
| Networked/remote | In-process is the right starting point — v1.0 |

### Validation Plan

1. **Unit tests** — Every type, function, and state transition covered
2. **Property-based tests** — Contract serialization round-trips, schema validation
3. **Integration test** — Forge research→draft pipeline with 200 trace replay
4. **Benchmark** — L1 overhead <200ms per validation, zero-GC pressure in hot path

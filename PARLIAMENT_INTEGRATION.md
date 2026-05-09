# Lattice × Parliament Integration Design

## Overview

Parliament is a synthetic discourse engine that runs multi-model deliberations. Each model responds to a topic independently, then a synthesizer produces a consensus. This is a **multi-agent pipeline** — exactly what Lattice is built to coordinate.

The integration wraps Parliament's model calls with Lattice State Contracts, validates responses through Circuit Breakers, and produces an audit trail of which models succeed, fail, or disagree at each deliberation step.

## Architecture

### Current Parliament Flow (without Lattice)

```
Topic → [Model A, Model B, Model C, ...] → Responses → Synthesizer → Synthesis
```

Each model runs independently. If a model hallucinates, produces garbage, or disagrees fundamentally, Parliament has no mechanism to catch it before synthesis. The synthesizer sees all outputs equally.

### With Lattice Integration

```
Topic → [Model A, Model B, Model C, ...]
         │         │         │
         ▼         ▼         ▼
      State     State     State
    Contract  Contract  Contract
         │         │         │
         ▼         ▼         ▼
     Circuit   Circuit   Circuit
    Breaker   Breaker   Breaker
         │         │         │
         ▼         ▼         ▼
     [Valid]   [Valid]  [Rejected]
         │         │         │
         ▼         ▼         ▼
      ──────► ConsensusReducer ◄──────
                    │
                    ▼
               Synthesis
```

### What Lattice Adds

1. **State Contracts for every model response** — each model's output is wrapped with:
   - Input (the topic/context the model received)
   - Output (the model's response)
   - Decisions (reasoning trace, if available)
   - Constraints (what the model couldn't address)
   - Assumptions (what the model assumed)

2. **Circuit Breaker validation per model**:
   - **L1**: Structural — is the response valid JSON? Does it match the expected schema?
   - **L2**: Semantic — does the response address the topic? (embedding similarity to topic)
   - **L3**: Quality — is the response coherent and on-topic? (LLM-as-judge, only if L2 is uncertain)

3. **ConsensusReducer for synthesis** — Parliament's synthesizer becomes a Lattice Reducer:
   - Detects when models disagree (conflict flagging)
   - Computes agreement ratio across all model responses
   - Flags high-confidence vs low-confidence synthesis

4. **Audit trail for model performance** — after each deliberation:
   - Which models passed validation?
   - Which models were rejected?
   - What was the agreement ratio?
   - What conflicts were detected?

## Integration Points

### 1. Wrap Model Calls with State Contracts

In Parliament's `/ideate` mode, each model call becomes:

```typescript
// Before (current)
const response = await model.generate(prompt);

// After (with Lattice)
const wrappedModel = wrapAgent(
  async (topic) => model.generate(topic),
  { id: model.name, breaker: { tier: 'auto' } }
);
const contract = await wrappedModel(topic, traceId);
```

### 2. Circuit Breaker per Model

Each model gets its own circuit breaker:

- **Cooperative models** (proposer, expander, pragmatist, lateralist): L1 + L2 validation
- **Adversarial models** (skeptic, devils-advocate): L1 only (they're supposed to be contrarian)
- **Synthesizer**: L1 + L3 (synthesis quality matters most)

### 3. ConsensusReducer for Synthesis

The synthesizer step uses Lattice's ConsensusReducer:

```typescript
const reducer = new ConsensusReducer({
  consensusFields: ['mainPoint', 'supportingArguments', 'conclusion'],
  conflictStrategy: 'flag-only',
  minAgreementRatio: 0.6,
});

const result = reducer.reduce(modelContracts);
```

This produces:
- **Consensus output** — the agreed-upon synthesis
- **Conflicts** — points of disagreement between models
- **Agreement ratio** — how much the models agreed

### 4. Audit Trail

Each deliberation produces:
- One State Contract per model response
- One State Contract for the synthesis
- One aggregate audit entry with:
  - Total models that passed validation
  - Total models that were rejected
  - Agreement ratio
  - Conflict details
  - Circuit breaker state changes

## Deliverables

### 1. `@heybeaux/lattice-adapter-parliament` (npm package)

- `wrapParliamentModel()` — wraps a Parliament model with Lattice coordination
- `ParliamentCircuitBreaker` — per-model validation with auto mode
- `ParliamentReducer` — ConsensusReducer configured for Parliament synthesis
- `ParliamentAuditLogger` — exports deliberation audit data

### 2. Parliament `/ideate` Integration

Modify Parliament's `/ideate` command to:
- Enable Lattice wrapping via config flag (`--lattice=true`)
- Produce State Contracts for every model response
- Use ConsensusReducer for synthesis
- Output audit data alongside the synthesis

### 3. Benchmark: Model Performance Tracking

After 100+ deliberations:
- Per-model pass/fail rates
- Per-model hallucination detection rates
- Per-topic agreement ratios
- Model-specific circuit breaker triggers

## Value Proposition

**For Parliament users:**
- Catch hallucinations and off-topic responses before they reach synthesis
- Quantify which models are most reliable for which task types
- Export audit trails for compliance (SOC 2, EU AI Act)

**For Lattice:**
- Parliament becomes a **reference implementation** of Lattice in production
- Real-world data on model reliability across deliberation tasks
- Proof that Lattice works with any multi-agent system, not just pipelines

## Timeline

1. **Week 1**: Design + prototype `@heybeaux/lattice-adapter-parliament`
2. **Week 2**: Integrate with Parliament's `/ideate` mode
3. **Week 3**: Run 100+ deliberations, collect audit data
4. **Week 4**: Publish benchmark results + case study

---

*Design by Cirrus ☁️ — May 9, 2026*

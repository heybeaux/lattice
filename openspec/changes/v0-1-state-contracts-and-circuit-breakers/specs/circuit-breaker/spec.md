# Delta for Circuit Breaker

## ADDED Requirements

### Requirement: Tiered Circuit Breaker
The system SHALL provide a circuit breaker with three validation tiers, allowing consumers to configure the level of scrutiny per handoff.

- **L1 — Structural**: Deterministic JSON Schema validation of the State Contract. Fast (<200ms), zero LLM calls, always enabled.
- **L2 — Semantic Consistency**: Embedding-based similarity check between input expectations and output content. Medium speed (~500ms), optional.
- **L3 — LLM-as-Judge**: Language model evaluates whether the output "actually addresses the task." Slow (1-3s), reserved for high-stakes handoffs, includes confidence score and human escalation fallback.

#### Scenario: L1 validation passes
- GIVEN a State Contract with valid schema
- WHEN validated at L1
- THEN validation passes in <200ms
- AND no LLM calls are made

#### Scenario: L1 validation fails on schema error
- GIVEN a State Contract with a missing required field
- WHEN validated at L1
- THEN validation fails immediately
- AND the error includes the specific schema violation path

#### Scenario: L2 semantic consistency check
- GIVEN a State Contract and L2 enabled
- WHEN validated at L2
- THEN an embedding comparison is performed between input task description and output content
- AND if similarity is below threshold, validation fails with a similarity score

#### Scenario: L3 LLM-as-judge with confidence
- GIVEN a State Contract and L3 enabled
- WHEN validated at L3
- THEN an LLM evaluates the output against the task
- AND returns a verdict (pass/fail/uncertain) with a confidence score (0-1)
- AND if confidence is below threshold (default 0.7), escalation is triggered

#### Scenario: L3 human escalation fallback
- GIVEN L3 validation returns "uncertain" with confidence below threshold
- AND an escalation handler is configured
- THEN the contract is held pending human review
- AND the escalation handler receives the full State Contract with validation context
- AND the pipeline is blocked until the handler responds

### Requirement: Circuit Breaker Configuration
The system SHALL allow per-handoff circuit breaker configuration.

#### Scenario: Different handoffs use different tiers
- GIVEN a pipeline with three agents (A → B → C)
- AND A→B configured with L1 only
- AND B→C configured with L1 + L3
- WHEN the pipeline executes
- THEN A→B uses only structural validation
- AND B→C uses structural + LLM-as-judge validation

#### Scenario: Global default with per-handoff override
- GIVEN a pipeline with default tier L1
- AND a specific handoff configured with L1 + L2
- WHEN validation runs
- THEN the specific handoff uses L1 + L2
- AND all other handoffs use L1 only

### Requirement: Circuit Breaker State Management
The system SHALL track circuit breaker state per handoff pair (fromAgent → toAgent).

States:
- `closed` — validation passing, normal operation
- `open` — validation failing, handoff blocked
- `half-open` — testing whether the handoff has recovered

#### Scenario: Circuit opens after consecutive failures
- GIVEN a circuit breaker with failure threshold of 3
- AND a handoff that fails validation 3 consecutive times
- THEN the circuit transitions to `open`
- AND subsequent handoffs are blocked immediately without validation

#### Scenario: Circuit enters half-open after timeout
- GIVEN a circuit breaker in `open` state
- AND the recovery timeout has elapsed (default 60s)
- WHEN the next handoff is attempted
- THEN the circuit transitions to `half-open`
- AND a single validation attempt is allowed

#### Scenario: Circuit closes on recovery
- GIVEN a circuit breaker in `half-open` state
- WHEN the validation attempt succeeds
- THEN the circuit transitions to `closed`
- AND normal operation resumes

#### Scenario: Circuit reopens on half-open failure
- GIVEN a circuit breaker in `half-open` state
- WHEN the validation attempt fails
- THEN the circuit transitions back to `open`
- AND the recovery timeout resets

### Requirement: Circuit Breaker Observability
The system SHALL emit metrics for every circuit breaker event.

Metrics:
- `lattice.circuit_breaker.validation_duration_ms` — histogram per tier
- `lattice.circuit_breaker.validation_result` — counter (pass/fail/escalated)
- `lattice.circuit_breaker.state_change` — counter per state transition
- `lattice.circuit_breaker.confidence_score` — histogram (L3 only)

#### Scenario: Metrics emitted for each validation
- GIVEN a pipeline with circuit breakers enabled
- WHEN a validation runs
- THEN a `validation_duration_ms` metric is emitted
- AND a `validation_result` counter is incremented

### Requirement: Budget Enforcement
The system SHALL validate that agent execution stayed within its allocated resource budget.

#### Scenario: Budget exceeded
- GIVEN a handoff with a budget limit of 10,000 tokens
- AND an agent that consumed 12,000 tokens
- WHEN budget enforcement is enabled
- THEN validation fails with a `BUDGET_EXCEEDED` reason
- AND the excess amount is included in the failure context

#### Scenario: Budget within limits
- GIVEN a handoff with a budget limit
- AND an agent that consumed less than the limit
- WHEN budget enforcement is enabled
- THEN budget validation passes
- AND remaining budget is recorded in the contract

### Requirement: Pipeline Abort on Validation Failure
The system SHALL provide configurable behavior when a circuit breaker rejects a contract.

Behaviors:
- `abort` — stop the pipeline immediately (default)
- `fallback` — use a fallback output if one is registered
- `retry` — re-execute the agent with enriched context (max N retries)
- `degrade` — continue with the failed contract but flag it downstream

#### Scenario: Pipeline aborts on rejection
- GIVEN a pipeline with abort behavior
- AND a circuit breaker that rejects a contract
- THEN the pipeline stops immediately
- AND a `pipeline:aborted` event is emitted with the rejection reason

#### Scenario: Pipeline retries on rejection
- GIVEN a pipeline with retry behavior (max 2 retries)
- AND a circuit breaker that rejects a contract
- THEN the agent is re-executed with the rejection reason as context
- AND if it passes on retry, the pipeline continues
- AND if it fails after max retries, the pipeline aborts

### Requirement: Zero-LLM Default Mode
The system SHALL operate fully with L1-only validation (zero LLM calls) for cost-sensitive or offline deployments.

#### Scenario: L1-only pipeline runs without LLM
- GIVEN a pipeline with only L1 validation enabled
- AND no LLM API key configured
- WHEN the pipeline executes
- THEN all validations pass or fail based on structural checks alone
- AND no LLM API calls are made

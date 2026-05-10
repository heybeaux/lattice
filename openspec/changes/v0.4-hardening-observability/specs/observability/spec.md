# Delta for Structured Observability

## ADDED Requirements

### Requirement: OpenTelemetry Span Exporter
The system SHALL export OpenTelemetry spans for every Lattice operation: contract validation, circuit state changes, and pipeline execution.

#### Scenario: Contract validation creates spans
- GIVEN a pipeline with circuit breakers enabled
- WHEN a State Contract is validated
- THEN an OTel span is created with:
  - span name: `lattice.contract.validate`
  - attributes: `lattice.tier` (L1/L2/L3), `lattice.passed` (bool), `lattice.latency_ms` (int), `lattice.trace_id` (string)

#### Scenario: Circuit state changes create events
- GIVEN a CircuitBreaker with OTel enabled
- WHEN the circuit transitions to 'open', 'closed', or 'half-open'
- THEN an OTel span is created with:
  - span name: `lattice.circuit.state_change`
  - attributes: `lattice.from_state`, `lattice.to_state`, `lattice.agent_id`

#### Scenario: Pipeline execution creates parent span
- GIVEN a pipeline execution
- WHEN the pipeline runs
- THEN an OTel parent span is created with:
  - span name: `lattice.pipeline.execute`
  - attributes: `lattice.step_count` (int), `lattice.total_duration_ms` (int), `lattice.had_rejected` (bool)
  - child spans for each step validation

### Requirement: JSON-Line Log Export
The system SHALL optionally export all events as JSON-line logs to a file path.

#### Scenario: JSON-line log is written
- GIVEN a JSON-line exporter with output path
- WHEN any Lattice event occurs
- THEN a JSON-line entry is appended to the file
- AND each line is a complete, valid JSON object

#### Scenario: JSON-line log is structured
- GIVEN a JSON-line log file
- WHEN parsed line by line
- THEN each line contains: `timestamp`, `event_type`, `data`, `metadata`
- AND `event_type` is one of: `contract:emitted`, `contract:validated`, `contract:rejected`, `circuit:opened`, `circuit:closed`, `circuit:half-open`, `pipeline:started`, `pipeline:completed`, `pipeline:aborted`

## ADDED Types

```typescript
interface OtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: string;
  endTime: string;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error' | 'unset';
}

interface JsonLineEntry {
  timestamp: string;
  event_type: string;
  data: Record<string, unknown>;
  metadata: {
    version: string; // "0.4.0"
    agent_id?: string;
    trace_id?: string;
  };
}
```

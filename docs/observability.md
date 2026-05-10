# Lattice Observability

Lattice emits structured events for every significant operation. Two exporters are included:

| Exporter | Format | Dependencies |
|----------|--------|--------------|
| `JsonLineExporter` | Newline-delimited JSON (`.jsonl`) | None — always available |
| `OtelExporter` | OpenTelemetry spans via OTLP | Optional peer deps (see below) |

Both exporters attach to a Lattice `EventEmitter` (typically `globalEmitter`) and convert events into their respective output format. They can be used together.

## JsonLineExporter

Appends every Lattice event as a single JSON line to a file. Each line is a complete, valid JSON object — trivially parseable with `jq`, `grep`, or any log aggregation tool.

### Setup

```typescript
import { JsonLineExporter, globalEmitter } from '@heybeaux/lattice-core';

const exporter = new JsonLineExporter({
  outputPath: './logs/lattice-events.jsonl',
});

exporter.attach(globalEmitter);

// Events are now logged. Runs until process exits.
```

The output directory is created if it does not exist. Each call to a Lattice operation (pipeline execution, contract validation, circuit breaker state change) appends one or more lines.

### Configuration

```typescript
interface JsonLineExporterConfig {
  /** Path to the output file. Required. */
  outputPath: string;

  /**
   * Lattice version string written into every entry's metadata.
   * Useful when multiple versions run in the same environment.
   * Default: '0.4.0'
   */
  version?: string;
}
```

### Output Format

Each line is a `JsonLineEntry`:

```typescript
interface JsonLineEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type — see Event Types below */
  event_type: string;
  /** Event payload (varies by event_type) */
  data: Record<string, unknown>;
  metadata: {
    /** Lattice version */
    version: string;
    /** Agent that produced the contract, if available */
    agent_id?: string;
    /** Trace ID shared across all events in the same pipeline run */
    trace_id?: string;
  };
}
```

### Example Output

```jsonl
{"timestamp":"2026-05-10T14:00:00.123Z","event_type":"pipeline:started","data":{"traceId":"01HZXYZ","agentIds":["researcher","writer"]},"metadata":{"version":"0.4.0","trace_id":"01HZXYZ"}}
{"timestamp":"2026-05-10T14:00:00.245Z","event_type":"contract:validated","data":{"fromAgent":"researcher","tier":"L1","passed":true,"durationMs":2,"traceId":"01HZXYZ"},"metadata":{"version":"0.4.0","agent_id":"researcher","trace_id":"01HZXYZ"}}
{"timestamp":"2026-05-10T14:00:01.891Z","event_type":"contract:validated","data":{"fromAgent":"writer","tier":"L1","passed":true,"durationMs":1,"traceId":"01HZXYZ"},"metadata":{"version":"0.4.0","agent_id":"writer","trace_id":"01HZXYZ"}}
{"timestamp":"2026-05-10T14:00:01.893Z","event_type":"pipeline:completed","data":{"traceId":"01HZXYZ","contractCount":2,"durationMs":1770},"metadata":{"version":"0.4.0","trace_id":"01HZXYZ"}}
```

### Reading Entries Programmatically

```typescript
const entries = exporter.readEntries();
const failures = entries.filter(e => e.event_type === 'contract:rejected');
```

### Clearing the Log

```typescript
exporter.clear(); // Truncates the file to zero bytes
```

---

## OtelExporter

Converts Lattice events into [OpenTelemetry](https://opentelemetry.io/) spans and exports them via OTLP/HTTP to a compatible backend (Jaeger, Tempo, Honeycomb, Datadog, etc.).

### Dependencies

The OTel SDK is an **optional peer dependency**. If not installed, `OtelExporter` degrades gracefully — spans are tracked in memory but not exported to OTLP. Zero errors, zero configuration changes needed.

To enable OTLP export:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

### Setup

```typescript
import { OtelExporter, globalEmitter } from '@heybeaux/lattice-core';

const exporter = new OtelExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-agent-system',
});

exporter.attach(globalEmitter);
```

### Configuration

```typescript
interface OtelExporterConfig {
  /**
   * OTLP endpoint URL.
   * For OTLP/HTTP: 'http://localhost:4318/v1/traces'
   * For Jaeger:    'http://localhost:4317' (gRPC) or 'http://localhost:14268/api/traces' (HTTP)
   */
  endpoint: string;

  /**
   * Transport protocol. Default: 'http'
   * Note: 'grpc' requires @opentelemetry/exporter-trace-otlp-grpc (separate install).
   */
  protocol?: 'http' | 'grpc';

  /**
   * Service name reported to the OTel backend.
   * Default: 'lattice'
   */
  serviceName?: string;
}
```

### Span Reference

The following spans are emitted per pipeline execution:

#### `lattice.pipeline.execute`

Root span for a complete pipeline run. One span per `pipeline.execute()` call.

| Attribute | Type | Description |
|-----------|------|-------------|
| `lattice.trace_id` | string | Pipeline trace ID (ULID) |
| `lattice.contract_count` | number | Number of contracts validated |
| `lattice.duration_ms` | number | Total pipeline duration in ms |

Status: `ok` on completion, `error` on abort.

#### `lattice.contract.validate`

One span per contract validation (including both passed and rejected). Child of the pipeline root span when run inside a pipeline.

| Attribute | Type | Description |
|-----------|------|-------------|
| `lattice.tier` | string | Validation tier: `'L1'`, `'L2'`, or `'L3'` |
| `lattice.agent_id` | string | Agent that produced the contract |
| `lattice.trace_id` | string | Shared pipeline trace ID |
| `lattice.passed` | boolean | Whether validation passed |
| `lattice.duration_ms` | number | Validation duration in ms |

Status: `ok` if passed, `error` if rejected.

#### `lattice.circuit.state_change`

Emitted on every circuit breaker state transition (open → half-open → closed).

| Attribute | Type | Description |
|-----------|------|-------------|
| `lattice.circuit_id` | string | Breaker identifier (agent name) |
| `lattice.old_state` | string | Previous state |
| `lattice.new_state` | string | New state |

Status: always `ok`.

### Span Context Propagation

`OtelExporter` propagates trace context from pipeline root spans to child contract-validation spans. All spans within a single `pipeline.execute()` call share the same `traceId`, enabling end-to-end trace visualization in your backend.

```
pipeline.execute  [trace_id=01HZXYZ]
├── lattice.contract.validate [agent=researcher, tier=L1]
├── lattice.contract.validate [agent=researcher, tier=L2]
└── lattice.contract.validate [agent=writer, tier=L1]
```

### Detaching

```typescript
exporter.detach(globalEmitter); // Removes all event listeners
```

---

## Event Types

Both exporters listen to the same set of event types:

| Event Type | When Emitted |
|-----------|--------------|
| `contract:emitted` | A new State Contract was created by a `wrapAgent` call |
| `contract:validated` | A contract passed validation |
| `contract:rejected` | A contract failed validation |
| `circuit:opened` | A circuit breaker transitioned to `open` |
| `circuit:closed` | A circuit breaker returned to `closed` |
| `circuit:half-open` | A circuit breaker entered `half-open` for recovery testing |
| `pipeline:started` | A pipeline execution began |
| `pipeline:completed` | A pipeline execution finished successfully |
| `pipeline:aborted` | A pipeline execution was aborted (unrecoverable failure) |

## Using Both Exporters Together

```typescript
import { JsonLineExporter, OtelExporter, globalEmitter } from '@heybeaux/lattice-core';

// File log (always works)
new JsonLineExporter({ outputPath: './logs/lattice.jsonl' })
  .attach(globalEmitter);

// OTel (works only if SDK installed, degrades gracefully otherwise)
new OtelExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'my-pipeline',
}).attach(globalEmitter);

// Now run your pipeline normally — both exporters receive every event.
```

## Quick Start with Docker

Run a local OTel collector + Jaeger UI in one command:

```bash
docker run -d \
  -p 16686:16686 \  # Jaeger UI
  -p 4318:4318 \    # OTLP/HTTP
  jaegertracing/all-in-one:latest
```

Then open `http://localhost:16686` and search for service `lattice`.

# Delta for State Contract

## ADDED Requirements

### Requirement: State Contract Envelope
The system SHALL provide a typed envelope that wraps every agent handoff with structured context. The envelope contains:

- `id` — unique identifier (ULID)
- `schemaVersion` — envelope schema version (semver, mandatory from v0.1)
- `traceId` — cross-contract correlation ID for the full pipeline run
- `parentIds` — array of upstream contract IDs (for future parallel/merge support; empty array for sequential)
- `fromAgent` — identifier of the producing agent
- `toAgent` — identifier of the consuming agent (optional, null for fan-out)
- `timestamp` — ISO 8601 creation time
- `inputs` — what the agent received (opaque, typed)
- `decisions` — what the agent chose and why (structured reasoning trace)
- `outputs` — what the agent produced (opaque, typed)
- `constraints` — what the agent could not do and why
- `assumptions` — what the agent leaves for downstream agents to handle
- `budget` — resources consumed (tokens, API calls, wall-clock ms)
- `metadata` — optional free-form key-value pairs

#### Scenario: Contract created after agent execution
- GIVEN an agent that has completed its task
- WHEN `wrapAgent()` finishes execution
- THEN a State Contract is emitted containing all required fields
- AND `id` is a valid ULID
- AND `schemaVersion` matches the current envelope schema version

#### Scenario: Contract preserves opaque payload types
- GIVEN an agent that produces a structured output object
- WHEN the output is attached to a State Contract
- THEN `outputs.payload` contains the original object unchanged
- AND `outputs.contentType` indicates the payload MIME type or schema URI

#### Scenario: Contract supports null constraints and assumptions
- GIVEN an agent that completed all work without constraints
- WHEN the contract is emitted
- THEN `constraints` is an empty array
- AND `assumptions` is an empty array

### Requirement: Contract Serialization
The system SHALL serialize State Contracts to JSON that is round-trippable and validates against the published JSON Schema.

#### Scenario: Contract round-trips through JSON
- GIVEN a State Contract with nested objects and arrays
- WHEN serialized to JSON and parsed back
- THEN the reconstructed contract equals the original
- AND validates against the current JSON Schema

#### Scenario: Contract validates against schema
- GIVEN any State Contract emitted by the system
- WHEN validated against the published JSON Schema
- THEN validation passes without errors

### Requirement: Contract Immutability
The system SHALL treat emitted State Contracts as immutable. Any modification creates a new contract instance.

#### Scenario: Contract cannot be mutated after emission
- GIVEN an emitted State Contract
- WHEN code attempts to modify a field
- THEN the modification is either rejected (frozen) or creates a new instance
- AND the original contract remains unchanged

### Requirement: Contract Trace Correlation
The system SHALL provide a `traceId` that links all contracts within a single pipeline run.

#### Scenario: All contracts in a pipeline share traceId
- GIVEN a pipeline with three sequential agents (A → B → C)
- WHEN each agent emits a State Contract
- THEN all three contracts share the same `traceId`
- AND can be retrieved together by `traceId`

### Requirement: Contract Redaction
The system SHALL provide a redaction utility that scrubs sensitive data from State Contracts before they are logged or exported.

#### Scenario: Redaction removes sensitive fields
- GIVEN a State Contract with fields marked as sensitive in the schema
- WHEN the redaction utility is applied
- THEN sensitive values are replaced with `[REDACTED]`
- AND the contract structure is preserved (field names remain)

#### Scenario: Redaction is applied before logging
- GIVEN a pipeline with logging enabled
- WHEN a State Contract is emitted
- THEN the redaction utility runs before the contract is written to logs
- AND no sensitive data appears in log output

### Requirement: Contract Event Emission
The system SHALL emit events for contract lifecycle transitions via OpenTelemetry and a local EventEmitter.

#### Scenario: Contract emission event
- GIVEN a pipeline with circuit breakers enabled
- WHEN a State Contract is created
- THEN a `contract:emitted` event is emitted with the contract data
- AND an OpenTelemetry span is created with the contract as attributes

#### Scenario: Contract validation event
- WHEN a contract passes circuit breaker validation
- THEN a `contract:validated` event is emitted
- WHEN a contract fails validation
- THEN a `contract:rejected` event is emitted with the failure reason

### Requirement: Contract Envelope Versioning
The system SHALL embed a `schemaVersion` (semver string) in every contract envelope. Version is mandatory — contracts without it are rejected. Backward-read compatibility is guaranteed within a major version. Forward-incompatible contracts are rejected with a clear error.

#### Scenario: Contract rejected without schemaVersion
- GIVEN a contract envelope missing `schemaVersion`
- WHEN validated
- THEN validation fails with a `MISSING_SCHEMA_VERSION` error

#### Scenario: Forward-incompatible contract rejected
- GIVEN a contract created with schema version `0.2.0`
- WHEN validated by a runtime expecting version `0.1.0`
- THEN validation fails with a `FORWARD_INCOMPATIBLE` error
- AND the error includes the required minimum runtime version

#### Scenario: Backward-compatible upgrade
- GIVEN a contract created with schema version `0.1.0`
- WHEN validated by a runtime supporting version `0.1.x`
- THEN validation proceeds normally
- AND any new optional fields in the newer runtime are treated as undefined

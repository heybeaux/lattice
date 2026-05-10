# Tasks: Lattice v0.4.0 — Hardening & Observability

## 1. Persistent Circuit State

### 1.1 Persistence Backend Interface
- [ ] 1.1.1 Define `PersistenceBackend` interface (getState, setState, clearState)
- [ ] 1.1.2 Define `PersistedBreakerState` type
- [ ] 1.1.3 Add interface to `src/breaker/persistence.ts`
- [ ] 1.1.4 Write unit tests for interface

### 1.2 JSON File Backend
- [ ] 1.2.1 Implement `JsonFileBackend` with in-memory cache
- [ ] 1.2.2 Implement atomic write (temp file + rename)
- [ ] 1.2.3 Implement `loadFromFile()` on initialization
- [ ] 1.2.4 Write unit tests for JSON backend
- [ ] 1.2.5 Write integration test: state survives process restart

### 1.3 CircuitBreaker Persistence Integration
- [ ] 1.3.1 Add `persist` option to `CircuitBreakerConfig`
- [ ] 1.3.2 Implement `restoreState()` on initialization
- [ ] 1.3.3 Implement `persistState()` on state transitions
- [ ] 1.3.4 Add sync interval option (default: 1000ms)
- [ ] 1.3.5 Write unit tests for persistence integration

### 1.4 Multiple Breakers with Shared Persistence
- [ ] 1.4.1 Ensure breaker IDs are isolated in persistence backend
- [ ] 1.4.2 Write test: two breakers with same backend don't collide
- [ ] 1.4.3 Write test: concurrent writes from multiple breakers are atomic

## 2. L2 Embedding Integration

### 2.1 EmbeddingProvider Interface (already exists, validate)
- [ ] 2.1.1 Verify `EmbeddingProvider` interface in types.ts is correct
- [ ] 2.1.2 Add default cosine similarity implementation
- [ ] 2.1.3 Write unit tests for cosine similarity

### 2.2 OpenAI EmbeddingProvider
- [ ] 2.2.1 Implement `OpenAIEmbeddingProvider` in provider-openai
- [ ] 2.2.2 Add batching support (configurable batch size + window)
- [ ] 2.2.3 Add timeout handling (configurable, default 10s)
- [ ] 2.2.4 Add error handling for rate limits, network errors
- [ ] 2.2.5 Write unit tests for provider

### 2.3 TieredCircuitBreaker L2 Integration
- [ ] 2.3.1 Wire `EmbeddingProvider` into TieredCircuitBreaker.validateL2
- [ ] 2.3.2 Compute embeddings for input/output payloads
- [ ] 2.3.3 Compare using cosine similarity
- [ ] 2.3.4 Return similarity score as confidence
- [ ] 2.3.5 Write integration tests with mock embeddings

## 3. Structured Observability

### 3.1 JSON-Line Log Exporter
- [ ] 3.1.1 Implement `JsonLineExporter` class
- [ ] 3.1.2 Implement append-to-file with atomic writes
- [ ] 3.1.3 Define `JsonLineEntry` type
- [ ] 3.1.4 Wire to EventEmitter for all event types
- [ ] 3.1.5 Write unit tests for exporter
- [ ] 3.1.6 Write integration test: events are written in order

### 3.2 OpenTelemetry Exporter
- [ ] 3.2.1 Implement `OtelExporter` class
- [ ] 3.2.2 Implement OTLP/HTTP span creation
- [ ] 3.2.3 Define span names and attributes for each event type
- [ ] 3.2.4 Wire to EventEmitter
- [ ] 3.2.5 Write unit tests with mocked OTel SDK
- [ ] 3.2.6 Write integration test with mock OTel collector

### 3.3 Span Context Propagation
- [ ] 3.3.1 Add parent span support for pipeline execution
- [ ] 3.3.2 Propagate traceId to all child spans
- [ ] 3.3.3 Write integration test: parent-child span relationships

## 4. Config System

### 4.1 Config File Auto-Discovery
- [ ] 4.1.1 Implement `discoverConfig()` for cwd search
- [ ] 4.1.2 Support `.js`, `.yaml`, `.toml`, `.json` formats
- [ ] 4.1.3 Implement explicit path override
- [ ] 4.1.4 Write unit tests for discovery

### 4.2 Config Schema Validation
- [ ] 4.2.1 Define JSON Schema for `LatticeConfig`
- [ ] 4.2.2 Implement `validateConfig()` with Ajv
- [ ] 4.2.3 Implement `ConfigValidationError` with actionable messages
- [ ] 4.2.4 Write unit tests for validation

### 4.3 Config Defaults and Override
- [ ] 4.3.1 Implement `defaultConfig()` function
- [ ] 4.3.2 Implement `mergeConfigs()` with programmatic override
- [ ] 4.3.3 Implement `createConfig()` as main entry point
- [ ] 4.3.4 Write integration tests for config loading

## 5. Error Boundaries

### 5.1 Provider Timeout Handling
- [ ] 5.1.1 Implement `ProviderTimeoutError` class
- [ ] 5.1.2 Implement `withTimeout()` wrapper
- [ ] 5.1.3 Add timeout config to EmbeddingProvider and JudgeProvider
- [ ] 5.1.4 Write unit tests for timeout handling

### 5.2 Rate Limit Handling
- [ ] 5.2.1 Implement `ProviderRateLimitError` class
- [ ] 5.2.2 Implement `withRateLimit()` wrapper
- [ ] 5.2.3 Add retry-after backoff logic
- [ ] 5.2.4 Write unit tests for rate limit handling

### 5.3 Malformed Response Handling
- [ ] 5.3.1 Implement `MalformedProviderResponseError` class
- [ ] 5.3.2 Add response validation before parsing
- [ ] 5.3.3 Include raw response in error for debugging
- [ ] 5.3.4 Write unit tests for malformed response handling

### 5.4 Graceful Degradation
- [ ] 5.4.1 Add `providerFailure` metadata to contracts on provider failure
- [ ] 5.4.2 Ensure degrade mode works with provider failures
- [ ] 5.4.3 Write integration test: pipeline continues when provider fails

## 6. Documentation

- [ ] 6.1 Update README with v0.4.0 features
- [ ] 6.2 Add config file documentation
- [ ] 6.3 Add observability documentation
- [ ] 6.4 Add error boundary documentation
- [ ] 6.5 Add migration guide from v0.3.0 to v0.4.0
- [ ] 6.6 Add examples for each new feature

## 7. Tests

- [ ] 7.1 All unit tests pass (target: 150+ tests)
- [ ] 7.2 All integration tests pass
- [ ] 7.3 CI passes on Node 20, 22, 24
- [ ] 7.4 Build produces valid ESM + types
- [ ] 7.5 No breaking changes (all v0.3.0 tests still pass)

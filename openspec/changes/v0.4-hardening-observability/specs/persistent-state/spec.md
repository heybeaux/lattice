# Delta for Persistent Circuit State

## ADDED Requirements

### Requirement: CircuitBreaker State Persistence
The system SHALL persist CircuitBreaker state (closed/open/half-open, consecutive failures, openedAt, recoveryTimeout) to durable storage and restore it on initialization.

#### Scenario: State persists across restarts
- GIVEN a CircuitBreaker that has transitioned to 'open' state
- WHEN the process restarts and a new CircuitBreaker is created with the same persistence path
- THEN the breaker initializes to 'open' state with the correct recovery timeout
- AND the circuit closes when the recovery timeout elapses

#### Scenario: State is written atomically
- GIVEN a CircuitBreaker with persistence enabled
- WHEN a state transition occurs
- THEN the state is written to storage atomically
- AND a partial write does not corrupt the state file

#### Scenario: Storage is optional
- GIVEN a CircuitBreaker without persistence configuration
- WHEN the breaker transitions states
- THEN no persistence occurs (current behavior unchanged)

#### Scenario: Multiple breakers share persistence
- GIVEN multiple CircuitBreakers with the same persistence backend
- WHEN each breaker transitions independently
- THEN each breaker's state is isolated and persisted separately

## MODIFIED Requirements

### Requirement: CircuitBreaker Configuration
The system SHALL accept a `persist` configuration option to enable state persistence.

```typescript
interface CircuitBreakerConfig {
  // ... existing fields ...
  persist?: {
    /** Storage backend: 'json' (default) or 'sqlite' */
    backend?: 'json' | 'sqlite';
    /** Path to state file or database */
    path: string;
    /** Sync interval in ms (default: 1000) */
    syncIntervalMs?: number;
  };
}
```

## ADDED Types

```typescript
interface PersistedBreakerState {
  /** Breaker identifier (from constructor) */
  id: string;
  /** Current state */
  state: 'closed' | 'open' | 'half-open';
  /** Consecutive failure count */
  consecutiveFailures: number;
  /** When the circuit was opened (ISO 8601) */
  openedAt: string | null;
  /** Recovery timeout in ms */
  recoveryTimeoutMs: number;
  /** Total times opened */
  timesOpened: number;
  /** Last state change timestamp */
  lastStateChange: string;
}
```

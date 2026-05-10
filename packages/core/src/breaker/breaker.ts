/**
 * Circuit Breaker states following the classic Nygaard pattern.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Configuration for a single circuit breaker instance.
 */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold?: number;
  /** Milliseconds to wait before transitioning from open to half-open */
  recoveryTimeoutMs?: number;
  /** Persistence backend for state survival across restarts */
  persistence?: import('./persistence.js').PersistenceBackend;
  /** Unique identifier for this breaker (used for persistence) */
  id?: string;
}

/**
 * Metrics emitted by a circuit breaker.
 */
export interface CircuitMetrics {
  /** Total validation attempts */
  totalAttempts: number;
  /** Total successes */
  totalSuccesses: number;
  /** Total failures */
  totalFailures: number;
  /** Consecutive failures (resets on success) */
  consecutiveFailures: number;
  /** Current state */
  state: CircuitState;
  /** Last state change timestamp (ISO 8601) */
  lastStateChange: string;
  /** Total times the circuit has opened */
  timesOpened: number;
}

/**
 * Classic circuit breaker state machine.
 *
 * States:
 * - **closed**: Normal operation. Validations run normally.
 * - **open**: Circuit is tripped. Validations are rejected immediately.
 * - **half-open**: Testing recovery. A single validation attempt is allowed.
 *
 * Transitions:
 * - closed → open: After N consecutive failures (failureThreshold)
 * - open → half-open: After recoveryTimeoutMs has elapsed
 * - half-open → closed: On successful validation
 * - half-open → open: On failed validation
 */
export class CircuitBreaker {
  private _state: CircuitState = 'closed';
  private _consecutiveFailures = 0;
  private _openedAt: number | null = null;
  private _metrics: CircuitMetrics = {
    totalAttempts: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    consecutiveFailures: 0,
    state: 'closed',
    lastStateChange: new Date().toISOString(),
    timesOpened: 0,
  };

  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly persistence?: import('./persistence.js').PersistenceBackend;
  private readonly id: string;

  constructor(config?: CircuitBreakerConfig) {
    this.failureThreshold = config?.failureThreshold ?? 3;
    this.recoveryTimeoutMs = config?.recoveryTimeoutMs ?? 60_000;
    this.persistence = config?.persistence;
    this.id = config?.id ?? `breaker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Restore persisted state. Call after construction.
   */
  async restoreState(): Promise<void> {
    if (!this.persistence) return;
    const saved = await this.persistence.getState(this.id);
    if (!saved) return;

    this._state = saved.state;
    this._consecutiveFailures = saved.consecutiveFailures;
    this._metrics.consecutiveFailures = saved.consecutiveFailures;
    this._metrics.state = saved.state;
    this._metrics.timesOpened = saved.timesOpened;
    this._metrics.lastStateChange = saved.lastStateChange;

    if (saved.openedAt) {
      this._openedAt = new Date(saved.openedAt).getTime();
    }

    // Check if recovery timeout has elapsed while we were down
    if (this._state === 'open' && this._openedAt !== null) {
      const elapsed = Date.now() - this._openedAt;
      if (elapsed >= this.recoveryTimeoutMs) {
        this.transitionTo('half-open');
      }
    }
  }

  /**
   * Persist current state to the backend.
   */
  private async persistState(): Promise<void> {
    if (!this.persistence) return;
    await this.persistence.setState(this.id, {
      id: this.id,
      state: this._state,
      consecutiveFailures: this._consecutiveFailures,
      openedAt: this._openedAt !== null ? new Date(this._openedAt).toISOString() : null,
      recoveryTimeoutMs: this.recoveryTimeoutMs,
      timesOpened: this._metrics.timesOpened,
      lastStateChange: this._metrics.lastStateChange,
    });
  }

  /** Current state of the circuit breaker */
  get state(): CircuitState {
    // Auto-transition from open to half-open if timeout has elapsed
    if (this._state === 'open' && this._openedAt !== null) {
      const elapsed = Date.now() - this._openedAt;
      if (elapsed >= this.recoveryTimeoutMs) {
        this.transitionTo('half-open');
      }
    }
    return this._state;
  }

  /** Current circuit breaker metrics */
  get metrics(): Readonly<CircuitMetrics> {
    return { ...this._metrics, state: this.state };
  }

  /** Whether the circuit allows validation attempts */
  canAttempt(): boolean {
    return this.state !== 'open';
  }

  /**
   * Record a successful validation.
   *
   * If in half-open state, transitions to closed (recovery confirmed).
   */
  recordSuccess(): void {
    this._metrics.totalAttempts++;
    this._metrics.totalSuccesses++;
    this._consecutiveFailures = 0;
    this._metrics.consecutiveFailures = 0;

    if (this._state === 'half-open') {
      this.transitionTo('closed');
    }

    this.persistState();
  }

  /**
   * Record a failed validation.
   *
   * If consecutive failures reach the threshold, transitions to open.
   * If in half-open state, immediately transitions back to open.
   */
  recordFailure(): void {
    this._metrics.totalAttempts++;
    this._metrics.totalFailures++;
    this._consecutiveFailures++;
    this._metrics.consecutiveFailures = this._consecutiveFailures;

    if (this._state === 'half-open') {
      this.transitionTo('open');
      return;
    }

    if (this._consecutiveFailures >= this.failureThreshold) {
      this.transitionTo('open');
    }

    this.persistState();
  }

  /**
   * Reset the circuit breaker to closed state.
   * Useful for manual recovery or testing.
   */
  reset(): void {
    this._state = 'closed';
    this._consecutiveFailures = 0;
    this._openedAt = null;
    this._metrics.consecutiveFailures = 0;
    this.transitionTo('closed');
  }

  private transitionTo(newState: CircuitState): void {
    if (this._state === newState) return;

    this._state = newState;
    this._metrics.state = newState;
    this._metrics.lastStateChange = new Date().toISOString();

    if (newState === 'open') {
      this._openedAt = Date.now();
      this._metrics.timesOpened++;
    } else if (newState === 'closed') {
      this._openedAt = null;
    }

    this.persistState();
  }
}

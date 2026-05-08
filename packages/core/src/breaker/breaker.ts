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

  constructor(config?: CircuitBreakerConfig) {
    this.failureThreshold = config?.failureThreshold ?? 3;
    this.recoveryTimeoutMs = config?.recoveryTimeoutMs ?? 60_000;
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

  /** Current metrics snapshot */
  get metrics(): Readonly<CircuitMetrics> {
    return { ...this._metrics, state: this.state };
  }

  /**
   * Check if the circuit allows a validation attempt.
   *
   * Returns true if the circuit is closed or half-open (allowing the test attempt).
   * Returns false if the circuit is open (blocking immediately).
   */
  canAttempt(): boolean {
    const state = this.state; // triggers auto-transition check
    return state === 'closed' || state === 'half-open';
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
  }
}

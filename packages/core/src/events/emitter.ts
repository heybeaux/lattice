import { StateContract } from '../contract/types.js';
import { CircuitState } from '../breaker/breaker.js';
import { ValidationResult } from '../breaker/types.js';

/**
 * Event types emitted by Lattice.
 */
export type LatticeEventType =
  | 'contract:emitted'
  | 'contract:validated'
  | 'contract:rejected'
  | 'circuit:opened'
  | 'circuit:closed'
  | 'circuit:half-open'
  | 'pipeline:started'
  | 'pipeline:completed'
  | 'pipeline:aborted';

/**
 * Base event interface.
 */
export interface LatticeEvent<T extends LatticeEventType = LatticeEventType> {
  type: T;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Event handler function.
 */
export type LatticeEventHandler = (event: LatticeEvent) => void;

/**
 * Local event emitter for Lattice coordination events.
 *
 * Provides synchronous, in-process event dispatching for application-level
 * handling. For observability, use the OpenTelemetry integration.
 */
export class EventEmitter {
  private handlers = new Map<LatticeEventType, Set<LatticeEventHandler>>();

  /**
   * Register an event handler.
   */
  on(type: LatticeEventType, handler: LatticeEventHandler): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  /**
   * Remove an event handler.
   */
  off(type: LatticeEventType, handler: LatticeEventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /**
   * Remove all handlers for an event type (or all types if none specified).
   */
  offAll(type?: LatticeEventType): void {
    if (type) {
      this.handlers.delete(type);
    } else {
      this.handlers.clear();
    }
  }

  /**
   * Emit an event to all registered handlers.
   */
  emit(type: LatticeEventType, data: Record<string, unknown>): void {
    const event: LatticeEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };

    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Handlers should not throw — swallow to avoid breaking the pipeline
        }
      }
    }
  }

  /**
   * Emit a contract:emitted event.
   */
  contractEmitted(contract: StateContract): void {
    this.emit('contract:emitted', {
      contractId: contract.id,
      fromAgent: contract.fromAgent,
      traceId: contract.traceId,
    });
  }

  /**
   * Emit a contract:validated event.
   */
  contractValidated(contract: StateContract, tier: string): void {
    this.emit('contract:validated', {
      contractId: contract.id,
      fromAgent: contract.fromAgent,
      tier,
    });
  }

  /**
   * Emit a contract:rejected event.
   */
  contractRejected(contract: StateContract, validation: ValidationResult): void {
    this.emit('contract:rejected', {
      contractId: contract.id,
      fromAgent: contract.fromAgent,
      tier: validation.tier,
      reason: validation.reason,
    });
  }

  /**
   * Emit a circuit state change event.
   */
  circuitStateChanged(
    fromAgent: string,
    fromState: CircuitState,
    toState: CircuitState,
  ): void {
    const eventType: LatticeEventType =
      toState === 'open'
        ? 'circuit:opened'
        : toState === 'closed'
          ? 'circuit:closed'
          : 'circuit:half-open';

    this.emit(eventType, {
      fromAgent,
      fromState,
      toState,
    });
  }

  /**
   * Emit a pipeline event.
   */
  pipelineStarted(agentIds: string[], traceId: string): void {
    this.emit('pipeline:started', { agentIds, traceId });
  }

  pipelineCompleted(
    traceId: string,
    contractCount: number,
    durationMs: number,
    hadRejected: boolean,
  ): void {
    this.emit('pipeline:completed', {
      traceId,
      contractCount,
      durationMs,
      hadRejected,
    });
  }

  pipelineAborted(
    traceId: string,
    failedAgentId: string,
    reason: string,
  ): void {
    this.emit('pipeline:aborted', {
      traceId,
      failedAgentId,
      reason,
    });
  }
}

/**
 * Shared global event emitter instance.
 * Used by wrapAgent and Pipeline to emit events automatically.
 */
export const globalEmitter = new EventEmitter();

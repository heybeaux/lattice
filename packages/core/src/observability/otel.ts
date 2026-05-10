/**
 * OpenTelemetry exporter for Lattice events.
 *
 * Converts Lattice events into OTel spans and exports them via OTLP.
 * The OTel SDK (@opentelemetry/sdk-node, @opentelemetry/exporter-trace-otlp-http)
 * is a **peer dependency** — if not installed, the exporter degrades gracefully
 * by tracking spans internally without exporting to OTLP.
 *
 * @example
 * ```typescript
 * import { OtelExporter, globalEmitter } from '@heybeaux/lattice-core';
 *
 * const exporter = new OtelExporter({
 *   endpoint: 'http://localhost:4318/v1/traces',
 *   serviceName: 'my-agent-system',
 * });
 * exporter.attach(globalEmitter);
 * ```
 */

import { randomUUID } from 'crypto';
import type { EventEmitter, LatticeEvent, LatticeEventType, LatticeEventHandler } from '../events/emitter.js';

/**
 * A span representing a traced operation in the Lattice system.
 */
export interface OtelSpan {
  /** Unique identifier for this span */
  spanId: string;
  /** Trace identifier — shared by all spans in the same pipeline execution */
  traceId: string;
  /** Span name (e.g., 'lattice.contract.validate') */
  name: string;
  /** Unix epoch milliseconds when the span started */
  startTime: number;
  /** Span attributes */
  attributes: Record<string, unknown>;
  /** Parent span ID (set for child spans within a pipeline) */
  parentSpanId?: string;
}

/** Internal tracked span with lifecycle metadata */
interface TrackedSpan extends OtelSpan {
  _endTime?: number;
  _status?: 'ok' | 'error';
  _otelSpan?: unknown; // real OTel SDK span, if available
}

/**
 * Configuration for the OtelExporter.
 */
export interface OtelExporterConfig {
  /** OTLP endpoint URL (e.g., 'http://localhost:4318/v1/traces') */
  endpoint: string;
  /** Transport protocol (default: 'http') */
  protocol?: 'http' | 'grpc';
  /** Service name reported to the OTel backend (default: 'lattice') */
  serviceName?: string;
}

/**
 * OpenTelemetry span exporter for Lattice.
 *
 * Attaches to a Lattice EventEmitter and converts events into OTel spans.
 * Implements span context propagation: contract validation spans are children
 * of the pipeline span that started for the same traceId.
 */
export class OtelExporter {
  private readonly config: OtelExporterConfig;

  /** Active spans keyed by spanId */
  private readonly activeSpans = new Map<string, TrackedSpan>();

  /** Active pipeline root spans keyed by traceId — used for parent propagation */
  private readonly activePipelineSpans = new Map<string, TrackedSpan>();

  /** Registered event handlers for detach */
  private readonly _listeners: Array<{
    type: LatticeEventType;
    handler: LatticeEventHandler;
  }> = [];

  /** Real OTel SDK tracer, if available */
  private _otelTracer: unknown = null;
  private _otelContextApi: unknown = null;
  private _otelSpanStatusCode: { OK: number; ERROR: number } | null = null;
  private _otelInitAttempted = false;

  constructor(config: OtelExporterConfig) {
    this.config = config;
  }

  /**
   * Create and track a new span.
   *
   * If the attributes include `lattice.trace_id`, that value is used as the
   * OTel traceId so spans from the same pipeline share a trace.
   */
  startSpan(name: string, attributes: Record<string, unknown>): OtelSpan {
    const traceId =
      typeof attributes['lattice.trace_id'] === 'string'
        ? (attributes['lattice.trace_id'] as string)
        : randomUUID().replace(/-/g, '');

    const spanId = randomUUID().replace(/-/g, '');

    // Determine parent: if there is an active pipeline span for this traceId,
    // this span is a child of it.
    const parentPipelineSpan = this.activePipelineSpans.get(traceId);
    const parentSpanId = parentPipelineSpan?.spanId;

    const span: TrackedSpan = {
      spanId,
      traceId,
      name,
      startTime: Date.now(),
      attributes,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    };

    this.activeSpans.set(spanId, span);

    // Bridge to real OTel SDK if available
    if (this._otelTracer) {
      try {
        span._otelSpan = this._startRealOtelSpan(span);
      } catch {
        // Silently degrade — real SDK failed but our span is still tracked
      }
    }

    return span;
  }

  /**
   * End a tracked span.
   */
  endSpan(span: OtelSpan, status: 'ok' | 'error'): void {
    const tracked = this.activeSpans.get(span.spanId);
    if (!tracked) return;

    tracked._status = status;
    tracked._endTime = Date.now();
    this.activeSpans.delete(span.spanId);

    // Bridge to real OTel SDK if available
    if (tracked._otelSpan) {
      try {
        this._endRealOtelSpan(tracked._otelSpan, status);
      } catch {
        // Silently degrade
      }
    }
  }

  /**
   * Attach to an EventEmitter and start listening to all Lattice event types.
   *
   * Triggers a one-time attempt to initialize the optional OTel SDK in the
   * background; span tracking always works regardless of whether the SDK
   * is present.
   */
  attach(emitter: EventEmitter): void {
    // Attempt OTel SDK initialization in the background (fire-and-forget)
    this._tryInitOtel().catch(() => {/* graceful degradation */});

    this._addListener(emitter, 'pipeline:started', (event: LatticeEvent) => {
      this._onPipelineStarted(event);
    });

    this._addListener(emitter, 'pipeline:completed', (event: LatticeEvent) => {
      this._onPipelineCompleted(event);
    });

    this._addListener(emitter, 'pipeline:aborted', (event: LatticeEvent) => {
      this._onPipelineAborted(event);
    });

    this._addListener(emitter, 'contract:validated', (event: LatticeEvent) => {
      this._onContractValidated(event);
    });

    this._addListener(emitter, 'contract:rejected', (event: LatticeEvent) => {
      this._onContractRejected(event);
    });

    this._addListener(emitter, 'circuit:opened', (event: LatticeEvent) => {
      this._onCircuitStateChange(event, 'closed', 'open');
    });

    this._addListener(emitter, 'circuit:closed', (event: LatticeEvent) => {
      this._onCircuitStateChange(event, 'open', 'closed');
    });

    this._addListener(emitter, 'circuit:half-open', (event: LatticeEvent) => {
      this._onCircuitStateChange(event, 'open', 'half-open');
    });
  }

  /**
   * Detach from an EventEmitter, removing all registered handlers.
   */
  detach(emitter: EventEmitter): void {
    for (const { type, handler } of this._listeners) {
      emitter.off(type, handler);
    }
    this._listeners.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Private event handlers
  // ---------------------------------------------------------------------------

  private _onPipelineStarted(event: LatticeEvent): void {
    const { traceId, agentIds } = event.data as {
      traceId?: string;
      agentIds?: string[];
    };

    const span = this.startSpan('lattice.pipeline.execute', {
      'lattice.trace_id': traceId ?? '',
      'lattice.contract_count': Array.isArray(agentIds) ? agentIds.length : 0,
      'lattice.duration_ms': 0,
    });

    // Store the pipeline span so child spans can reference it
    const traceKey = traceId ?? span.traceId;
    this.activePipelineSpans.set(traceKey, this.activeSpans.get(span.spanId)!);
  }

  private _onPipelineCompleted(event: LatticeEvent): void {
    const { traceId, contractCount, durationMs } = event.data as {
      traceId?: string;
      contractCount?: number;
      durationMs?: number;
    };

    const rootSpan = traceId ? this.activePipelineSpans.get(traceId) : undefined;
    if (rootSpan) {
      // Update attributes with final values before ending
      rootSpan.attributes['lattice.contract_count'] = contractCount ?? 0;
      rootSpan.attributes['lattice.duration_ms'] = durationMs ?? 0;
      this.activePipelineSpans.delete(traceId!);
      this.endSpan(rootSpan, 'ok');
    }
  }

  private _onPipelineAborted(event: LatticeEvent): void {
    const { traceId } = event.data as { traceId?: string };

    const rootSpan = traceId ? this.activePipelineSpans.get(traceId) : undefined;
    if (rootSpan) {
      this.activePipelineSpans.delete(traceId!);
      this.endSpan(rootSpan, 'error');
    }
  }

  private _onContractValidated(event: LatticeEvent): void {
    const { tier, fromAgent, traceId, durationMs, passed } = event.data as {
      tier?: string;
      fromAgent?: string;
      traceId?: string;
      durationMs?: number;
      passed?: boolean;
    };

    const span = this.startSpan('lattice.contract.validate', {
      'lattice.tier': tier ?? '',
      'lattice.agent_id': fromAgent ?? '',
      'lattice.trace_id': traceId ?? '',
      'lattice.passed': passed ?? true,
      'lattice.duration_ms': durationMs ?? 0,
    });

    this.endSpan(span, 'ok');
  }

  private _onContractRejected(event: LatticeEvent): void {
    const { tier, fromAgent, traceId, durationMs } = event.data as {
      tier?: string;
      fromAgent?: string;
      traceId?: string;
      durationMs?: number;
    };

    const span = this.startSpan('lattice.contract.validate', {
      'lattice.tier': tier ?? '',
      'lattice.agent_id': fromAgent ?? '',
      'lattice.trace_id': traceId ?? '',
      'lattice.passed': false,
      'lattice.duration_ms': durationMs ?? 0,
    });

    this.endSpan(span, 'error');
  }

  private _onCircuitStateChange(
    event: LatticeEvent,
    oldState: string,
    newState: string,
  ): void {
    const { fromAgent } = event.data as { fromAgent?: string };

    const span = this.startSpan('lattice.circuit.state_change', {
      'lattice.circuit_id': fromAgent ?? '',
      'lattice.old_state': oldState,
      'lattice.new_state': newState,
    });

    this.endSpan(span, 'ok');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _addListener(
    emitter: EventEmitter,
    type: LatticeEventType,
    handler: LatticeEventHandler,
  ): void {
    emitter.on(type, handler);
    this._listeners.push({ type, handler });
  }

  /**
   * Attempt to initialize the real OTel SDK.
   * This is fire-and-forget — failure means graceful no-op mode.
   */
  private async _tryInitOtel(): Promise<void> {
    if (this._otelInitAttempted) return;
    this._otelInitAttempted = true;

    try {
      // Dynamic imports keep OTel SDK as a true peer/optional dep:
      // if the packages are absent the catch swallows the error.
      const [sdkMod, exporterMod, apiMod] = await Promise.all([
        import('@opentelemetry/sdk-node' as string),
        import('@opentelemetry/exporter-trace-otlp-http' as string),
        import('@opentelemetry/api' as string),
      ]);

      const { NodeSDK } = sdkMod as {
        NodeSDK: new (opts: Record<string, unknown>) => { start(): void };
      };
      const { OTLPTraceExporter } = exporterMod as {
        OTLPTraceExporter: new (opts: Record<string, unknown>) => unknown;
      };
      const { trace, SpanStatusCode } = apiMod as {
        trace: { getTracer(name: string): unknown };
        SpanStatusCode: { OK: number; ERROR: number };
      };

      const traceExporter = new OTLPTraceExporter({ url: this.config.endpoint });
      const sdk = new NodeSDK({
        traceExporter,
        serviceName: this.config.serviceName ?? 'lattice',
      });
      sdk.start();

      this._otelTracer = trace.getTracer('lattice');
      this._otelContextApi = apiMod;
      this._otelSpanStatusCode = SpanStatusCode;
    } catch {
      // OTel SDK not installed — degrade to internal-only span tracking.
      // Spans are still created and the parent-child relationships are
      // maintained; they just are not exported to an OTLP backend.
    }
  }

  /**
   * Create a real OTel span via the SDK tracer.
   * Returns the SDK span object for later use in _endRealOtelSpan.
   */
  private _startRealOtelSpan(span: TrackedSpan): unknown {
    const tracer = this._otelTracer as {
      startSpan(
        name: string,
        opts?: Record<string, unknown>,
        ctx?: unknown,
      ): unknown;
    };

    const opts: Record<string, unknown> = {
      attributes: span.attributes,
      startTime: span.startTime,
    };

    // If there is a parent pipeline span, pass its OTel context
    if (span.parentSpanId) {
      const parentTracked = [...this.activeSpans.values()].find(
        s => s.spanId === span.parentSpanId,
      );
      if (parentTracked?._otelSpan) {
        const api = this._otelContextApi as {
          context: { active(): unknown };
          trace: { setSpan(ctx: unknown, span: unknown): unknown };
        };
        opts['_parentContext'] = api.trace.setSpan(
          api.context.active(),
          parentTracked._otelSpan,
        );
      }
    }

    return tracer.startSpan(span.name, opts);
  }

  /**
   * End a real OTel span.
   */
  private _endRealOtelSpan(otelSpan: unknown, status: 'ok' | 'error'): void {
    const s = otelSpan as {
      setStatus(s: { code: number }): void;
      end(): void;
    };
    if (this._otelSpanStatusCode) {
      s.setStatus({
        code: status === 'ok'
          ? this._otelSpanStatusCode.OK
          : this._otelSpanStatusCode.ERROR,
      });
    }
    s.end();
  }
}

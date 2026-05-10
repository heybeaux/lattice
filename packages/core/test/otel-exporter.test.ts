import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OtelExporter } from '../src/observability/otel.js';
import { EventEmitter } from '../src/events/emitter.js';
import type { OtelSpan } from '../src/observability/otel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExporter(): OtelExporter {
  return new OtelExporter({
    endpoint: 'http://localhost:4318/v1/traces',
    serviceName: 'test-lattice',
  });
}

// ---------------------------------------------------------------------------
// Unit tests for OtelExporter.startSpan / endSpan
// ---------------------------------------------------------------------------

describe('OtelExporter — startSpan / endSpan', () => {
  it('returns a span with the expected fields', () => {
    const exporter = makeExporter();
    const span = exporter.startSpan('lattice.contract.validate', {
      'lattice.tier': 'L1',
      'lattice.agent_id': 'agent-1',
      'lattice.trace_id': 'trace-abc',
      'lattice.passed': true,
      'lattice.duration_ms': 12,
    });

    expect(span).toMatchObject({
      name: 'lattice.contract.validate',
      traceId: 'trace-abc',
      attributes: expect.objectContaining({
        'lattice.tier': 'L1',
        'lattice.agent_id': 'agent-1',
        'lattice.trace_id': 'trace-abc',
        'lattice.passed': true,
        'lattice.duration_ms': 12,
      }),
    });
    expect(typeof span.spanId).toBe('string');
    expect(span.spanId.length).toBeGreaterThan(0);
    expect(typeof span.startTime).toBe('number');
    expect(span.startTime).toBeGreaterThan(0);
  });

  it('generates a traceId when lattice.trace_id attribute is absent', () => {
    const exporter = makeExporter();
    const span = exporter.startSpan('lattice.circuit.state_change', {
      'lattice.circuit_id': 'c1',
    });
    expect(typeof span.traceId).toBe('string');
    expect(span.traceId.length).toBeGreaterThan(0);
  });

  it('endSpan does not throw for unknown span', () => {
    const exporter = makeExporter();
    const fakeSpan: OtelSpan = {
      spanId: 'does-not-exist',
      traceId: 'trace-1',
      name: 'test',
      startTime: Date.now(),
      attributes: {},
    };
    expect(() => exporter.endSpan(fakeSpan, 'ok')).not.toThrow();
  });

  it('startSpan / endSpan are spyable', () => {
    const exporter = makeExporter();
    const startSpy = vi.spyOn(exporter, 'startSpan');
    const endSpy = vi.spyOn(exporter, 'endSpan');

    const span = exporter.startSpan('test.span', { 'key': 'val' });
    exporter.endSpan(span, 'ok');

    expect(startSpy).toHaveBeenCalledOnce();
    expect(endSpy).toHaveBeenCalledOnce();
    expect(endSpy).toHaveBeenCalledWith(span, 'ok');
  });
});

// ---------------------------------------------------------------------------
// attach / detach produces spans for all event types
// ---------------------------------------------------------------------------

describe('OtelExporter — attach produces spans for event types', () => {
  let exporter: OtelExporter;
  let emitter: EventEmitter;
  let startSpy: ReturnType<typeof vi.spyOn>;
  let endSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exporter = makeExporter();
    emitter = new EventEmitter();
    startSpy = vi.spyOn(exporter, 'startSpan');
    endSpy = vi.spyOn(exporter, 'endSpan');
    exporter.attach(emitter);
  });

  afterEach(() => {
    exporter.detach(emitter);
    vi.restoreAllMocks();
  });

  it('creates a span for contract:validated', () => {
    emitter.emit('contract:validated', {
      tier: 'L1',
      fromAgent: 'agent-a',
      traceId: 'trace-1',
      durationMs: 5,
      passed: true,
    });

    expect(startSpy).toHaveBeenCalledOnce();
    expect(startSpy).toHaveBeenCalledWith(
      'lattice.contract.validate',
      expect.objectContaining({
        'lattice.tier': 'L1',
        'lattice.agent_id': 'agent-a',
        'lattice.trace_id': 'trace-1',
        'lattice.passed': true,
        'lattice.duration_ms': 5,
      }),
    );
    expect(endSpy).toHaveBeenCalledOnce();
    expect(endSpy).toHaveBeenCalledWith(expect.any(Object), 'ok');
  });

  it('creates an error span for contract:rejected', () => {
    emitter.emit('contract:rejected', {
      tier: 'L2',
      fromAgent: 'agent-b',
      traceId: 'trace-2',
      durationMs: 20,
    });

    expect(startSpy).toHaveBeenCalledOnce();
    const span = startSpy.mock.results[0].value as OtelSpan;
    expect(span.attributes['lattice.passed']).toBe(false);
    expect(endSpy).toHaveBeenCalledWith(expect.any(Object), 'error');
  });

  it('creates a span for pipeline:started and pipeline:completed', () => {
    emitter.emit('pipeline:started', {
      agentIds: ['a', 'b', 'c'],
      traceId: 'trace-pipe',
    });

    // startSpan called for pipeline:started
    expect(startSpy).toHaveBeenCalledTimes(1);

    emitter.emit('pipeline:completed', {
      traceId: 'trace-pipe',
      contractCount: 3,
      durationMs: 150,
    });

    // endSpan called for pipeline:completed (root span ends)
    expect(endSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'lattice.pipeline.execute' }),
      'ok',
    );
  });

  it('creates a span for circuit:opened', () => {
    emitter.emit('circuit:opened', {
      fromAgent: 'agent-x',
      fromState: 'closed',
      toState: 'open',
    });

    expect(startSpy).toHaveBeenCalledOnce();
    const span = startSpy.mock.results[0].value as OtelSpan;
    expect(span.name).toBe('lattice.circuit.state_change');
    expect(span.attributes['lattice.circuit_id']).toBe('agent-x');
    expect(span.attributes['lattice.old_state']).toBe('closed');
    expect(span.attributes['lattice.new_state']).toBe('open');
    expect(endSpy).toHaveBeenCalledWith(expect.any(Object), 'ok');
  });

  it('creates a span for circuit:closed', () => {
    emitter.emit('circuit:closed', { fromAgent: 'agent-y' });
    const span = startSpy.mock.results[0].value as OtelSpan;
    expect(span.attributes['lattice.old_state']).toBe('open');
    expect(span.attributes['lattice.new_state']).toBe('closed');
  });

  it('creates a span for circuit:half-open', () => {
    emitter.emit('circuit:half-open', { fromAgent: 'agent-z' });
    const span = startSpy.mock.results[0].value as OtelSpan;
    expect(span.attributes['lattice.new_state']).toBe('half-open');
  });
});

// ---------------------------------------------------------------------------
// Span attributes
// ---------------------------------------------------------------------------

describe('OtelExporter — span attributes', () => {
  it('contract:validated span contains all required attributes', () => {
    const exporter = makeExporter();
    const emitter = new EventEmitter();
    const startSpy = vi.spyOn(exporter, 'startSpan');
    exporter.attach(emitter);

    emitter.emit('contract:validated', {
      tier: 'L3',
      fromAgent: 'judge-agent',
      traceId: 'trace-xyz',
      durationMs: 100,
      passed: true,
    });

    const [name, attrs] = startSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('lattice.contract.validate');
    expect(attrs['lattice.tier']).toBe('L3');
    expect(attrs['lattice.agent_id']).toBe('judge-agent');
    expect(attrs['lattice.trace_id']).toBe('trace-xyz');
    expect(attrs['lattice.passed']).toBe(true);
    expect(attrs['lattice.duration_ms']).toBe(100);

    exporter.detach(emitter);
  });

  it('pipeline span contains all required attributes after completion', () => {
    const exporter = makeExporter();
    const emitter = new EventEmitter();
    const endSpy = vi.spyOn(exporter, 'endSpan');
    exporter.attach(emitter);

    emitter.emit('pipeline:started', { agentIds: ['a', 'b'], traceId: 'trace-p1' });
    emitter.emit('pipeline:completed', { traceId: 'trace-p1', contractCount: 2, durationMs: 200 });

    const pipelineSpan = endSpy.mock.calls[0][0] as OtelSpan;
    expect(pipelineSpan.attributes['lattice.trace_id']).toBe('trace-p1');
    expect(pipelineSpan.attributes['lattice.contract_count']).toBe(2);
    expect(pipelineSpan.attributes['lattice.duration_ms']).toBe(200);

    exporter.detach(emitter);
  });
});

// ---------------------------------------------------------------------------
// Span context propagation — child spans share traceId from parent pipeline
// ---------------------------------------------------------------------------

describe('OtelExporter — span context propagation', () => {
  it('child spans share the traceId of the parent pipeline span', () => {
    const exporter = makeExporter();
    const emitter = new EventEmitter();
    const startSpy = vi.spyOn(exporter, 'startSpan');
    exporter.attach(emitter);

    const traceId = 'trace-propagate';

    emitter.emit('pipeline:started', { agentIds: ['a', 'b'], traceId });
    emitter.emit('contract:validated', {
      tier: 'L1',
      fromAgent: 'a',
      traceId,
      durationMs: 3,
      passed: true,
    });
    emitter.emit('contract:validated', {
      tier: 'L1',
      fromAgent: 'b',
      traceId,
      durationMs: 4,
      passed: true,
    });
    emitter.emit('pipeline:completed', { traceId, contractCount: 2, durationMs: 50 });

    // All spans should share the same traceId
    const spans = startSpy.mock.results.map(r => r.value as OtelSpan);
    expect(spans.length).toBe(3); // 1 pipeline + 2 contract

    for (const span of spans) {
      expect(span.traceId).toBe(traceId);
    }

    exporter.detach(emitter);
  });

  it('child contract spans have parentSpanId pointing to the pipeline span', () => {
    const exporter = makeExporter();
    const emitter = new EventEmitter();
    const startSpy = vi.spyOn(exporter, 'startSpan');
    exporter.attach(emitter);

    const traceId = 'trace-parent';

    emitter.emit('pipeline:started', { agentIds: ['agent-1'], traceId });
    emitter.emit('contract:validated', {
      tier: 'L1',
      fromAgent: 'agent-1',
      traceId,
      durationMs: 5,
      passed: true,
    });

    const pipelineSpan = startSpy.mock.results[0].value as OtelSpan;
    const contractSpan = startSpy.mock.results[1].value as OtelSpan;

    expect(pipelineSpan.name).toBe('lattice.pipeline.execute');
    expect(contractSpan.name).toBe('lattice.contract.validate');

    // Contract span is a child of the pipeline span
    expect(contractSpan.parentSpanId).toBe(pipelineSpan.spanId);
    expect(contractSpan.traceId).toBe(pipelineSpan.traceId);

    exporter.detach(emitter);
  });

  it('multiple concurrent pipelines maintain isolated traceIds', () => {
    const exporter = makeExporter();
    const emitter = new EventEmitter();
    const startSpy = vi.spyOn(exporter, 'startSpan');
    exporter.attach(emitter);

    emitter.emit('pipeline:started', { agentIds: ['a'], traceId: 'trace-A' });
    emitter.emit('pipeline:started', { agentIds: ['b'], traceId: 'trace-B' });
    emitter.emit('contract:validated', { fromAgent: 'a', traceId: 'trace-A', tier: 'L1', passed: true, durationMs: 1 });
    emitter.emit('contract:validated', { fromAgent: 'b', traceId: 'trace-B', tier: 'L1', passed: true, durationMs: 2 });

    const spans = startSpy.mock.results.map(r => r.value as OtelSpan);
    const pipelineA = spans.find(s => s.traceId === 'trace-A' && s.name === 'lattice.pipeline.execute')!;
    const pipelineB = spans.find(s => s.traceId === 'trace-B' && s.name === 'lattice.pipeline.execute')!;
    const contractA = spans.find(s => s.traceId === 'trace-A' && s.name === 'lattice.contract.validate')!;
    const contractB = spans.find(s => s.traceId === 'trace-B' && s.name === 'lattice.contract.validate')!;

    expect(contractA.parentSpanId).toBe(pipelineA.spanId);
    expect(contractB.parentSpanId).toBe(pipelineB.spanId);
    expect(contractA.parentSpanId).not.toBe(pipelineB.spanId);

    exporter.detach(emitter);
  });

  it('contract spans without a preceding pipeline:started have no parentSpanId', () => {
    const exporter = makeExporter();
    const emitter = new EventEmitter();
    const startSpy = vi.spyOn(exporter, 'startSpan');
    exporter.attach(emitter);

    // Emit a contract:validated without any pipeline:started
    emitter.emit('contract:validated', {
      tier: 'L1',
      fromAgent: 'standalone',
      traceId: 'trace-standalone',
      durationMs: 2,
      passed: true,
    });

    const contractSpan = startSpy.mock.results[0].value as OtelSpan;
    expect(contractSpan.parentSpanId).toBeUndefined();

    exporter.detach(emitter);
  });
});

// ---------------------------------------------------------------------------
// Integration: detach stops producing spans
// ---------------------------------------------------------------------------

describe('OtelExporter — detach', () => {
  it('stops producing spans after detach', () => {
    const exporter = makeExporter();
    const emitter = new EventEmitter();
    const startSpy = vi.spyOn(exporter, 'startSpan');
    exporter.attach(emitter);

    emitter.emit('contract:validated', { tier: 'L1', fromAgent: 'a', traceId: 'trace-1', durationMs: 1, passed: true });
    expect(startSpy).toHaveBeenCalledTimes(1);

    exporter.detach(emitter);

    emitter.emit('contract:validated', { tier: 'L1', fromAgent: 'a', traceId: 'trace-2', durationMs: 1, passed: true });
    // No new spans after detach
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: pipeline:aborted ends root span with error status
// ---------------------------------------------------------------------------

describe('OtelExporter — pipeline:aborted', () => {
  it('ends the pipeline span with error status on abort', () => {
    const exporter = makeExporter();
    const emitter = new EventEmitter();
    const endSpy = vi.spyOn(exporter, 'endSpan');
    exporter.attach(emitter);

    emitter.emit('pipeline:started', { agentIds: ['a'], traceId: 'trace-abort' });
    emitter.emit('pipeline:aborted', { traceId: 'trace-abort', failedAgentId: 'a', reason: 'timeout' });

    expect(endSpy).toHaveBeenCalledOnce();
    expect(endSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'lattice.pipeline.execute' }),
      'error',
    );

    exporter.detach(emitter);
  });
});

// ---------------------------------------------------------------------------
// Integration: full pipeline execution — traceId propagated
// ---------------------------------------------------------------------------

describe('OtelExporter — integration: full pipeline trace propagation', () => {
  it('verifies parent-child span relationship through a complete pipeline run', () => {
    const exporter = makeExporter();
    const emitter = new EventEmitter();
    const startSpy = vi.spyOn(exporter, 'startSpan');
    const endSpy = vi.spyOn(exporter, 'endSpan');
    exporter.attach(emitter);

    const traceId = 'integration-trace-001';

    // Simulate pipeline execution
    emitter.emit('pipeline:started', { agentIds: ['agent-1', 'agent-2'], traceId });
    emitter.emit('contract:validated', { tier: 'L1', fromAgent: 'agent-1', traceId, durationMs: 8, passed: true });
    emitter.emit('contract:validated', { tier: 'L2', fromAgent: 'agent-2', traceId, durationMs: 42, passed: true });
    emitter.emit('pipeline:completed', { traceId, contractCount: 2, durationMs: 55 });

    const allSpans = startSpy.mock.results.map(r => r.value as OtelSpan);
    expect(allSpans).toHaveLength(3);

    const [pipelineSpan, contract1Span, contract2Span] = allSpans;

    // All share the same traceId
    expect(pipelineSpan.traceId).toBe(traceId);
    expect(contract1Span.traceId).toBe(traceId);
    expect(contract2Span.traceId).toBe(traceId);

    // Contract spans are children of the pipeline span
    expect(contract1Span.parentSpanId).toBe(pipelineSpan.spanId);
    expect(contract2Span.parentSpanId).toBe(pipelineSpan.spanId);

    // Span names
    expect(pipelineSpan.name).toBe('lattice.pipeline.execute');
    expect(contract1Span.name).toBe('lattice.contract.validate');
    expect(contract2Span.name).toBe('lattice.contract.validate');

    // endSpan called 3 times (2 contracts + 1 pipeline)
    expect(endSpy).toHaveBeenCalledTimes(3);

    // Pipeline span ends with 'ok'
    const pipelineEnd = endSpy.mock.calls.find(
      ([s]) => (s as OtelSpan).name === 'lattice.pipeline.execute',
    );
    expect(pipelineEnd?.[1]).toBe('ok');

    exporter.detach(emitter);
  });
});

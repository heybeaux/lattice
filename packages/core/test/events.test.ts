import { describe, it, expect, vi } from 'vitest';
import {
  EventEmitter,
  globalEmitter,
  pipeline,
  HandoffFailure,
  createContract,
} from '../src/index.js';

describe('EventEmitter', () => {
  it('emits and receives events', () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();

    emitter.on('contract:emitted', handler);
    emitter.emit('contract:emitted', { contractId: 'abc' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'contract:emitted',
        data: { contractId: 'abc' },
      }),
    );
  });

  it('supports multiple handlers for same event', () => {
    const emitter = new EventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('pipeline:started', h1);
    emitter.on('pipeline:started', h2);
    emitter.emit('pipeline:started', { agentIds: ['a', 'b'] });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('removes handlers with off()', () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();

    emitter.on('contract:validated', handler);
    emitter.off('contract:validated', handler);
    emitter.emit('contract:validated', { contractId: 'abc' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('clears all handlers with offAll()', () => {
    const emitter = new EventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('contract:emitted', h1);
    emitter.on('pipeline:started', h2);
    emitter.offAll();

    emitter.emit('contract:emitted', {});
    emitter.emit('pipeline:started', {});

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('swallows handler errors to not break pipeline', () => {
    const emitter = new EventEmitter();
    const badHandler = vi.fn(() => {
      throw new Error('boom');
    });
    const goodHandler = vi.fn();

    emitter.on('contract:emitted', badHandler);
    emitter.on('contract:emitted', goodHandler);

    // Should not throw
    expect(() => emitter.emit('contract:emitted', {})).not.toThrow();
    expect(goodHandler).toHaveBeenCalled();
  });

  it('contractEmitted helper emits correct event', () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.on('contract:emitted', handler);

    const contract = createContract({
      fromAgent: 'test',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    emitter.contractEmitted(contract);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'contract:emitted',
        data: expect.objectContaining({
          contractId: contract.id,
          fromAgent: 'test',
        }),
      }),
    );
  });

  it('circuitStateChanged emits the correct event type', () => {
    const emitter = new EventEmitter();
    const openHandler = vi.fn();
    const closedHandler = vi.fn();
    emitter.on('circuit:opened', openHandler);
    emitter.on('circuit:closed', closedHandler);

    emitter.circuitStateChanged('agent-1', 'closed', 'open');
    expect(openHandler).toHaveBeenCalledTimes(1);

    emitter.circuitStateChanged('agent-1', 'open', 'closed');
    expect(closedHandler).toHaveBeenCalledTimes(1);
  });

  it('pipeline events emit correctly', () => {
    const emitter = new EventEmitter();
    const started = vi.fn();
    const completed = vi.fn();
    const aborted = vi.fn();

    emitter.on('pipeline:started', started);
    emitter.on('pipeline:completed', completed);
    emitter.on('pipeline:aborted', aborted);

    emitter.pipelineStarted(['a', 'b'], 'trace-1');
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentIds: ['a', 'b'],
          traceId: 'trace-1',
        }),
      }),
    );

    emitter.pipelineCompleted('trace-1', 2, 150, false);
    expect(completed).toHaveBeenCalled();

    emitter.pipelineAborted('trace-1', 'b', 'validation failed');
    expect(aborted).toHaveBeenCalled();
  });
});

describe('globalEmitter', () => {
  it('is a singleton instance', async () => {
    const { globalEmitter: g2 } = await import('../src/events/emitter.js');
    expect(globalEmitter).toBe(g2);
  });
});

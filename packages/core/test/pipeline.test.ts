import { describe, it, expect } from 'vitest';
import {
  pipeline,
  PipelineBuilder,
  HandoffFailure,
  createContract,
} from '../src/index.js';

describe('Pipeline', () => {
  it('executes a single agent pipeline', async () => {
    const p = pipeline()
      .agent('doubler', (input: { n: number }) => ({ result: input.n * 2 }), {
        breaker: { tier: 'L1' },
      })
      .build();

    const result = await p.execute({ n: 5 });

    expect(result.output.result).toBe(10);
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0].fromAgent).toBe('doubler');
    expect(result.hadRejected).toBe(false);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('executes a multi-agent sequential pipeline', async () => {
    const p = pipeline()
      .agent('researcher', (input: { query: string }) => ({
        summary: `Results for: ${input.query}`,
        citations: ['source1'],
      }), { breaker: { tier: 'L1' } })
      .agent('writer', (input: { summary: string; citations: string[] }) => ({
        article: `# Report\n\n${input.summary}\n\nRefs: ${input.citations.join(', ')}`,
      }), { breaker: { tier: 'L1' } })
      .build();

    const result = await p.execute({ query: 'AI coordination' });

    expect(result.output.article).toContain('Results for: AI coordination');
    expect(result.output.article).toContain('source1');
    expect(result.contracts).toHaveLength(2);
    expect(result.contracts[0].fromAgent).toBe('researcher');
    expect(result.contracts[1].fromAgent).toBe('writer');
    // Both contracts share the same traceId
    expect(result.contracts[0].traceId).toBe(result.contracts[1].traceId);
  });

  it('throws HandoffFailure on rejection (abort mode)', async () => {
    const p = pipeline()
      .agent('bad', (input: unknown) => ({ ok: true }), {
        breaker: { tier: 'L1+L3', onReject: 'abort' },
      })
      .onReject('abort')
      .build();

    // L3 fails without JudgeProvider → abort
    await expect(p.execute({})).rejects.toThrow(HandoffFailure);
  });

  it('degrade mode continues with rejected contracts', async () => {
    const p = pipeline()
      .agent('risky', (input: unknown) => ({ data: 'questionable' }), {
        breaker: { tier: 'L1+L3', onReject: 'degrade' },
      })
      .onReject('degrade')
      .build();

    const result = await p.execute({});

    expect(result.hadRejected).toBe(true);
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0].fromAgent).toBe('risky');
  });

  it('retry mode retries on failure', async () => {
    let attemptCount = 0;

    const p = pipeline()
      .agent('flaky', (input: unknown) => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('temporary failure');
        }
        return { success: true };
      }, {
        breaker: { tier: 'L1' },
      })
      .onReject('retry', { maxRetries: 3 })
      .build();

    const result = await p.execute({});

    expect(result.output.success).toBe(true);
    expect(attemptCount).toBe(3);
  });

  it('retry mode exhausts retries and throws', async () => {
    const p = pipeline()
      .agent('always-fails', () => {
        throw new Error('always breaks');
      }, {
        breaker: { tier: 'L1' },
      })
      .onReject('retry', { maxRetries: 2 })
      .build();

    await expect(p.execute({})).rejects.toThrow(HandoffFailure);
  });

  it('fallback mode throws not-implemented error', async () => {
    const p = pipeline()
      .agent('needs-fallback', (input: unknown) => {
        throw new Error('boom');
      }, {
        breaker: { tier: 'L1' },
      })
      .onReject('fallback')
      .build();

    await expect(p.execute({})).rejects.toThrow('fallback not implemented');
  });

  it('throws on empty pipeline', async () => {
    const p = pipeline().build();

    await expect(p.execute({})).rejects.toThrow('Pipeline has no agents');
  });

  // Issue #23 / H14: prior to the fix, the wrapAgent retry loop and the
  // pipeline retry loop multiplied (wrapper maxRetries=2 × pipeline
  // maxRetries=2 = up to 9 invocations per "configured retry"). The
  // wrapper-level retry has been removed; pipeline retry is the single
  // retry layer. This test asserts no compounding — exactly N+1 agent
  // invocations for `maxRetries: N` (the original attempt + N retries).
  it('pipeline-level retry does not compound with wrapAgent (#23)', async () => {
    let invocations = 0;

    const p = pipeline()
      .agent(
        'always-fails',
        () => {
          invocations++;
          throw new Error('boom');
        },
        {
          // Critically: the BREAKER ALSO requests 'retry' with maxRetries=2.
          // Pre-fix, this wrapper retry would multiply with the pipeline
          // retry and we'd see ~9 invocations. Post-fix, the wrapper
          // ignores 'retry' (warn-deprecate) and the pipeline owns the
          // retry semantics — exactly 3 invocations (1 + 2 retries).
          breaker: { tier: 'L1', onReject: 'retry', maxRetries: 2 },
        },
      )
      .onReject('retry', { maxRetries: 2 })
      .build();

    await expect(p.execute({})).rejects.toThrow(HandoffFailure);
    expect(invocations).toBe(3); // 1 initial + 2 pipeline retries; NOT 9
  });

  it('breaker.onReject="retry" no longer triggers wrapper retries (#23)', async () => {
    // No pipeline-level retry — only the (deprecated) breaker.onReject.
    // Pre-fix, this would still retry 2x at the wrapper. Post-fix, it
    // aborts immediately, surfaced as a HandoffFailure to the caller.
    let invocations = 0;
    const p = pipeline()
      .agent(
        'always-fails',
        () => {
          invocations++;
          throw new Error('boom');
        },
        {
          breaker: { tier: 'L1', onReject: 'retry', maxRetries: 5 },
        },
      )
      .onReject('abort')
      .build();

    await expect(p.execute({})).rejects.toThrow(HandoffFailure);
    expect(invocations).toBe(1); // exactly one invocation, no wrapper retries
  });

  it('tracks total duration', async () => {
    const p = pipeline()
      .agent('slow', async (input: unknown) => {
        await new Promise((r) => setTimeout(r, 30));
        return { done: true };
      }, { breaker: { tier: 'L1' } })
      .agent('also-slow', async (input: unknown) => {
        await new Promise((r) => setTimeout(r, 30));
        return { final: true };
      }, { breaker: { tier: 'L1' } })
      .build();

    const result = await p.execute({});

    expect(result.totalDurationMs).toBeGreaterThanOrEqual(55);
    expect(result.contracts).toHaveLength(2);
  });
});

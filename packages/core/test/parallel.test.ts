import { describe, it, expect } from 'vitest';
import { parallel, pipelineWithParallel } from '../src/index.js';

describe('parallel()', () => {
  it('executes branches concurrently and joins with "all" strategy', async () => {
    const result = await parallel(
      [
        { id: 'a', fn: async (input: { n: number }) => ({ doubled: input.n * 2 }) },
        { id: 'b', fn: async (input: { n: number }) => ({ tripled: input.n * 3 }) },
      ],
      { n: 5 },
      'all',
    );

    expect(result.allCompleted).toBe(true);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.output).toHaveLength(2);
    expect(result.contracts).toHaveLength(2);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns first successful output with "first" strategy', async () => {
    const result = await parallel(
      [
        { id: 'a', fn: async (input: { n: number }) => ({ result: input.n + 1 }) },
        { id: 'b', fn: async (input: { n: number }) => ({ result: input.n + 2 }) },
      ],
      { n: 5 },
      'first',
    );

    // Both branches succeed concurrently — `result` is the first to resolve.
    // We assert that it is a real success payload (not a default), and that
    // the call records both succeeded.
    expect([{ result: 6 }, { result: 7 }]).toContainEqual(result.output);
    expect(result.succeeded).toBe(2);
  });

  // Issue #10 / H6: 'first' must return the first SUCCESSFUL branch even
  // when an earlier-positioned branch fails. Prior behavior returned the
  // index-0 payload (i.e., the failure) and silently discarded later
  // successes. This test guards against regression.
  it('"first" returns the successful branch when an earlier-positioned branch fails (#10)', async () => {
    const result = await parallel(
      [
        // Branch a fails fast — it must NOT be the chosen output.
        { id: 'a', fn: async () => { throw new Error('boom'); } },
        { id: 'b', fn: async () => ({ ok: true, from: 'b' }) },
      ],
      {},
      'first',
    );

    expect(result.output).toEqual({ ok: true, from: 'b' });
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it('"first" prefers the temporally earliest fulfillment when multiple branches succeed', async () => {
    const result = await parallel(
      [
        // Slow branch — would be picked by 'first-position' but not by 'first'.
        {
          id: 'slow',
          fn: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return { from: 'slow' };
          },
        },
        // Fast branch wins the race.
        { id: 'fast', fn: async () => ({ from: 'fast' }) },
      ],
      {},
      'first',
    );

    expect(result.output).toEqual({ from: 'fast' });
    expect(result.succeeded).toBe(2);
  });

  it('"first" surfaces failure payload only when ALL branches fail', async () => {
    const result = await parallel(
      [
        { id: 'a', fn: async () => { throw new Error('a'); } },
        { id: 'b', fn: async () => { throw new Error('b'); } },
      ],
      {},
      'first',
    );

    expect(result.allCompleted).toBe(false);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(2);
    // Assert that the output contains the failure payload (null from HandoffFailure)
    expect(result.output).toBeNull();
  });

  // 'first-position' preserves the legacy index-0-wins semantics for callers
  // that genuinely want positional behavior. Documented as an explicit opt-in.
  it('"first-position" returns the index-0 branch even when it failed', async () => {
    const result = await parallel(
      [
        { id: 'a', fn: async (): Promise<{ ok: boolean }> => { throw new Error('a-failed'); } },
        { id: 'b', fn: async () => ({ ok: true }) },
      ],
      {},
      'first-position',
    );

    // Index-0 branch failed — its HandoffFailure-attached contract carries
    // `null` payload, so the join surfaces that null. Caller is responsible
    // for inspecting `succeeded`/`failed`.
    expect(result.output).toBeNull();
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it('returns majority output with "majority" strategy', async () => {
    const result = await parallel(
      [
        { id: 'a', fn: async () => ({ verdict: 'pass' }) },
        { id: 'b', fn: async () => ({ verdict: 'pass' }) },
        { id: 'c', fn: async () => ({ verdict: 'fail' }) },
      ],
      {},
      'majority',
    );

    expect(result.output).toEqual({ verdict: 'pass' });
  });

  it('tracks failed branches', async () => {
    const result = await parallel(
      [
        { id: 'good', fn: async () => ({ ok: true }) },
        {
          id: 'bad',
          fn: async () => { throw new Error('boom'); },
        },
      ],
      {},
      'all',
    );

    expect(result.allCompleted).toBe(false);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('shares traceId across all branch contracts', async () => {
    const traceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const result = await parallel(
      [
        { id: 'a', fn: async () => ({ x: 1 }) },
        { id: 'b', fn: async () => ({ x: 2 }) },
      ],
      {},
      'all',
      traceId,
    );

    for (const c of result.contracts) {
      expect(c.traceId).toBe(traceId);
    }
  });

  it('throws with zero branches', async () => {
    await expect(parallel([], {}, 'all')).rejects.toThrow('requires at least one branch');
  });
});

describe('pipelineWithParallel()', () => {
  it('builds a pipeline with fan-out/fan-in', async () => {
    const p = pipelineWithParallel<{ text: string }>()
      .agent('preprocess', (input: { text: string }) => ({ processed: input.text.toUpperCase() }), { breaker: { tier: 'L1' } })
      .parallel(
        [
          { id: 'extractor', fn: (input: { processed: string }) => ({ entities: ['test'] }), breaker: { tier: 'L1' } },
          { id: 'classifier', fn: (input: { processed: string }) => ({ category: 'A' }), breaker: { tier: 'L1' } },
        ],
        'all',
      )
      .agent('formatter', (input: any[]) => ({ report: input.map((r: any) => JSON.stringify(r)).join('\n') }), { breaker: { tier: 'L1' } })
      .build();

    const result = await p.execute({ text: 'hello world' });

    expect(result.output.report).toContain('entities');
    expect(result.output.report).toContain('category');
    expect(result.contracts.length).toBeGreaterThanOrEqual(3);
  });
});

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

    expect(result.output).toEqual({ result: 6 });
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

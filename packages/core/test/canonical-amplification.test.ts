import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wrap the canonicalize export with a counter so we can assert that a
// single TieredCircuitBreaker.validate() step canonicalizes any one
// payload reference at most once (issue #17).
//
// vi.mock with importActual lets us preserve real behavior while
// observing every invocation. The mock factory runs before any
// importer of '../src/util/canonical.js' (including transitive
// imports from tiered.ts) so all canonicalize calls in the system
// go through the counter.
vi.mock('../src/util/canonical.js', async () => {
  const actual = await vi.importActual<typeof import('../src/util/canonical.js')>(
    '../src/util/canonical.js',
  );
  return {
    ...actual,
    canonicalize: vi.fn(actual.canonicalize),
  };
});

import {
  TieredCircuitBreaker,
  createContract,
} from '../src/index.js';
import type { EmbeddingProvider, JudgeProvider } from '../src/index.js';
import * as canonModule from '../src/util/canonical.js';

const canonicalizeSpy = canonModule.canonicalize as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  canonicalizeSpy.mockClear();
});

// Mocks: deterministic providers so we can run L2 and force L3 escalation.
function makeEmbedding(): EmbeddingProvider {
  return {
    embed: vi.fn(async (_text: string) => [0.1, 0.2, 0.3]),
    similarity: vi.fn((_a: number[], _b: number[]) => 0.5), // below default 0.85 escalation threshold
  };
}

function makeJudge(): JudgeProvider {
  return {
    judge: vi.fn(async () => ({
      verdict: 'pass' as const,
      confidence: 0.9,
      reasoning: 'ok',
    })),
  };
}

describe('TieredCircuitBreaker — canonicalization amplification (issue #17)', () => {
  it('canonicalizes contract.inputs.payload at most ONCE per validate() step (auto mode, L1+L2+L3)', async () => {
    const cb = new TieredCircuitBreaker({
      tier: 'auto',
      l2Threshold: 0.0, // L2 always passes
      l3EscalationThreshold: 0.85, // similarity 0.5 < 0.85 → L3 runs
      l3ConfidenceThreshold: 0.0,
      // Disable provider redaction so the spy can compare object identity
      // against the raw inputsPayload reference. With redaction on (the new
      // default for issue #6), we canonicalize a deep clone — that path is
      // covered by the redaction tests in redact.test.ts and breaker.test.ts.
      providerRedaction: 'raw',
    });
    cb.setEmbeddingProvider(makeEmbedding());
    cb.setJudgeProvider(makeJudge());

    const inputsPayload = { z: 1, a: 2, nested: { y: 1, x: 2 } };
    const outputsPayload = { result: 'ok', items: [{ b: 2, a: 1 }] };
    const contract = createContract({
      fromAgent: 'test',
      inputs: inputsPayload,
      outputs: outputsPayload,
      budget: { tokensUsed: 10, callsMade: 1, wallClockMs: 5 },
    });
    canonicalizeSpy.mockClear(); // ignore createContract's own estimateByteSize calls

    const result = await cb.validate(contract);
    expect(result.passed).toBe(true);

    // Count how many times canonicalize was invoked specifically against the
    // inputs.payload reference (and outputs.payload). With the per-step memo
    // each should be at most ONE top-level call. Without the fix, both L2
    // and L3 would each call JSON.stringify on the same object — net 4
    // stringify passes for inputs+outputs across L2/L3.
    const inputCalls = canonicalizeSpy.mock.calls.filter(
      (args) => args[0] === inputsPayload,
    );
    const outputCalls = canonicalizeSpy.mock.calls.filter(
      (args) => args[0] === outputsPayload,
    );

    expect(inputCalls.length).toBeLessThanOrEqual(1);
    expect(outputCalls.length).toBeLessThanOrEqual(1);
    // And at least once — we still need a canonical form for L2/L3.
    expect(inputCalls.length).toBe(1);
    expect(outputCalls.length).toBe(1);
  });

  it('canonicalizes payloads at most once in manual L1+L2+L3 mode as well', async () => {
    const cb = new TieredCircuitBreaker({
      tier: 'L1+L2+L3',
      l2Threshold: 0.0,
      l3ConfidenceThreshold: 0.0,
      providerRedaction: 'raw', // see comment above
    });
    cb.setEmbeddingProvider(makeEmbedding());
    cb.setJudgeProvider(makeJudge());

    const inputsPayload = { foo: 'bar', list: [1, 2, 3] };
    const outputsPayload = { ok: true };
    const contract = createContract({
      fromAgent: 'test',
      inputs: inputsPayload,
      outputs: outputsPayload,
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 1 },
    });
    canonicalizeSpy.mockClear();

    const result = await cb.validate(contract);
    expect(result.passed).toBe(true);

    const inputCalls = canonicalizeSpy.mock.calls.filter(
      (args) => args[0] === inputsPayload,
    );
    const outputCalls = canonicalizeSpy.mock.calls.filter(
      (args) => args[0] === outputsPayload,
    );
    expect(inputCalls.length).toBe(1);
    expect(outputCalls.length).toBe(1);
  });
});

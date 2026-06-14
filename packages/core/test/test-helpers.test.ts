import { describe, it, expect } from 'vitest';
import { verifyCustomRuleDeterminism } from '../src/test-helpers.js';
import type { PolicyRule } from '../src/breaker/types.js';
import type { StateContract } from '../src/contract/types.js';

const baseRule = (
  id: string,
  evaluate: (c: StateContract) => boolean,
): PolicyRule => ({
  id,
  description: 'fuzz target',
  jsonpath: '$',
  kind: 'custom',
  evaluate,
});

describe('verifyCustomRuleDeterminism', () => {
  it('passes on a pure rule with default 100 fixtures', () => {
    const rule = baseRule('pure', (c) => !!c.outputs?.payload);
    const r = verifyCustomRuleDeterminism(rule);
    expect(r.passed).toBe(true);
    expect(r.fixtureCount).toBe(100);
  });

  it('honors a user-supplied fixture set', () => {
    const fixtures: StateContract[] = [
      {
        id: 'f1',
        schemaVersion: '0.1.0',
        traceId: 't',
        parentIds: [],
        fromAgent: 'a',
        toAgent: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        inputs: { payload: {}, contentType: 'application/json' },
        decisions: [],
        outputs: { payload: { tool: 'ok' }, contentType: 'application/json' },
        constraints: [],
        assumptions: [],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
        metadata: {},
      } as unknown as StateContract,
    ];
    const rule = baseRule('uses-fixtures', () => true);
    const r = verifyCustomRuleDeterminism(rule, { fixtures });
    expect(r.passed).toBe(true);
    expect(r.fixtureCount).toBe(1);
  });

  it('detects Math.random non-determinism', () => {
    const rule = baseRule('random', () => Math.random() > 0.5);
    const r = verifyCustomRuleDeterminism(rule);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/different values/);
    expect(r.offendingFixture).toBeDefined();
  });

  it('detects Date.now non-determinism (across iterations)', () => {
    let lastCall = -1;
    const rule = baseRule('clock', () => {
      // Branch on whether the clock has moved between calls. With 200 calls
      // across the suite (100 fixtures × 2 evals), at least one pair will
      // straddle a millisecond boundary on real wall clock.
      const now = Date.now();
      const moved = now !== lastCall;
      lastCall = now;
      return moved;
    });
    const r = verifyCustomRuleDeterminism(rule);
    expect(r.passed).toBe(false);
  });

  it('detects an inconsistent throw', () => {
    let counter = 0;
    const rule = baseRule('flaky-throw', () => {
      counter++;
      if (counter === 3) throw new Error('flaky on 3rd call');
      return true;
    });
    const r = verifyCustomRuleDeterminism(rule);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/threw on first run/);
  });

  it('detects a throw on the second call only', () => {
    let counter = 0;
    const rule = baseRule('throw-late', () => {
      counter++;
      // First call passes, second call (same fixture) throws.
      if (counter % 2 === 0) throw new Error('every other');
      return true;
    });
    const r = verifyCustomRuleDeterminism(rule);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/threw on second/);
  });

  it("accepts a rule that always throws with the SAME error message", () => {
    const rule = baseRule('always-throws', () => {
      throw new Error('deterministic boom');
    });
    const r = verifyCustomRuleDeterminism(rule);
    expect(r.passed).toBe(true);
  });

  it("detects a rule that throws with different error messages", () => {
    let i = 0;
    const rule = baseRule('different-throws', () => {
      i++;
      throw new Error(`boom-${i}`);
    });
    const r = verifyCustomRuleDeterminism(rule);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/threw different errors/);
  });

  it('rejects a non-custom rule with a clear error', () => {
    const rule: PolicyRule = {
      id: 'r',
      description: 'd',
      jsonpath: '$',
      kind: 'required',
    };
    expect(() => verifyCustomRuleDeterminism(rule)).toThrow(
      /only 'custom' rules need the fuzz check/,
    );
  });

  it('rejects a custom rule without a function evaluate', () => {
    const rule = {
      id: 'r',
      description: 'd',
      jsonpath: '$',
      kind: 'custom',
      evaluate: 'not-a-function',
    } as unknown as PolicyRule;
    expect(() => verifyCustomRuleDeterminism(rule)).toThrow(/no evaluate function/);
  });

  it('honors a custom iteration count', () => {
    const rule = baseRule('count', () => true);
    const r = verifyCustomRuleDeterminism(rule, { iterations: 7 });
    expect(r.fixtureCount).toBe(7);
  });

  it('produces identical fixtures across runs for the same seed', () => {
    // Collect the deterministic ids the harness exposes on its fixtures.
    // A pure rule passes; we capture the trace by recording fixture ids
    // from inside the rule. Same seed → same sequence of ids.
    const captureIds = (seed: number): string[] => {
      const ids: string[] = [];
      const rule = baseRule('capture', (c) => {
        ids.push(c.id);
        return true;
      });
      const result = verifyCustomRuleDeterminism(rule, { seed, iterations: 5 });
      expect(result.passed).toBe(true);
      // Each fixture gets evaluated twice; dedupe to compare the underlying sequence.
      return Array.from(new Set(ids));
    };
    const seqA = captureIds(42);
    const seqB = captureIds(42);
    expect(seqA).toEqual(seqB);
    expect(seqA).toHaveLength(5);
  });

  it('different seeds may produce different fixtures', () => {
    // Just a smoke test: both runs pass on a pure rule, regardless of seed.
    const rule = baseRule('pure', () => true);
    expect(verifyCustomRuleDeterminism(rule, { seed: 1 }).passed).toBe(true);
    expect(verifyCustomRuleDeterminism(rule, { seed: 2 }).passed).toBe(true);
  });

  it('detects throw of non-Error (string) and reports message', () => {
    let i = 0;
    const rule = baseRule('string-throw', () => {
      i++;
      if (i === 1) throw 'plain-string-error';
      return true;
    });
    const r = verifyCustomRuleDeterminism(rule);
    expect(r.passed).toBe(false);
  });
});

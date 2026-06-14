/**
 * Axis-2 tool-use scoring math, on a hand-built fixture with KNOWN expected outcomes.
 *
 * Fixture semantics (see src/score/tooluse.ts):
 *   - `malformed_args` is caughtBy 'rule'  -> every real config saves it.
 *   - `downstream_error` is caughtBy 'predictor' -> only `+awm` (when prediction escalates) saves it.
 *   - a null-injection call is a GOOD call -> never "fails"; only `+awm` can false-block it.
 */

import { describe, it, expect } from 'vitest';
import { scoreConfigToolUse, scoreToolUse } from '../src/score/tooluse.js';
import type { Episode, EpisodeCall } from '../src/generate.js';
import type { FailureMode } from '../src/corpus/taxonomy.js';

function call(
  tool: string,
  path: string,
  injectedFailure: FailureMode | null,
  thrash: number,
): EpisodeCall {
  return {
    tool,
    path,
    call: { tool, command: path },
    injectedFailure,
    thrash,
  };
}

/** One episode: 1 rule-catchable fail, 1 predictor-only fail, 1 good call. */
function fixture(): Episode[] {
  return [
    {
      id: 0,
      calls: [
        call('Bash', 'a', 'malformed_args', 0.1), // rule-catchable failure
        call('Bash', 'b', 'downstream_error', 0.1), // predictor-only failure (low thrash)
        call('Bash', 'c', null, 0.1), // good call
      ],
    },
  ];
}

describe('scoreConfigToolUse', () => {
  it('none baseline fails every injected call and never intervenes', () => {
    const r = scoreConfigToolUse('none', fixture());
    expect(r.metrics.totalCalls).toBe(3);
    expect(r.metrics.injectedFailures).toBe(2);
    expect(r.metrics.failedCalls).toBe(2); // both injected calls fail under none
    expect(r.metrics.falseBlocks).toBe(0);
    expect(r.metrics.failedCallRate).toBeCloseTo(2 / 3, 10);
  });

  it('regex saves only rule-catchable failures, leaves predictor failures', () => {
    const r = scoreConfigToolUse('regex', fixture());
    // malformed_args saved; downstream_error not (regex has no predictor) -> 1 failed call.
    expect(r.metrics.failedCalls).toBe(1);
    expect(r.metrics.falseBlocks).toBe(0); // regex never false-blocks the synthetic good call
    expect(r.metrics.successfulCalls).toBe(2);
  });

  it('regex+decode matches regex on these failure modes (no obfuscation present)', () => {
    const regex = scoreConfigToolUse('regex', fixture());
    const decode = scoreConfigToolUse('regex+decode', fixture());
    expect(decode.metrics.failedCalls).toBe(regex.metrics.failedCalls);
  });

  it('records retries: saved calls cost less than raw failures', () => {
    const none = scoreConfigToolUse('none', fixture());
    const regex = scoreConfigToolUse('regex', fixture());
    // regex saves the malformed_args call -> fewer total retries than none.
    expect(regex.metrics.meanRetriesToSuccess).toBeLessThan(none.metrics.meanRetriesToSuccess);
  });
});

describe('scoreToolUse failed-call reduction (headline)', () => {
  it('reduction is 0 for none and positive for configs that save', () => {
    const map = scoreToolUse(['none', 'regex', 'regex+decode', 'regex+decode+awm'], fixture());
    const none = map.get('none')!;
    const regex = map.get('regex')!;
    expect(none.metrics.failedCallReduction).toBe(0);
    // none fails 2, regex fails 1 -> reduction = (2-1)/2 = 0.5
    expect(regex.metrics.failedCallReduction).toBeCloseTo(0.5, 10);
    // +awm should reduce at least as much as regex (catches predictor modes too).
    const awm = map.get('regex+decode+awm')!;
    expect(awm.metrics.failedCallReduction).toBeGreaterThanOrEqual(regex.metrics.failedCallReduction);
  });
});

describe('over-time slope', () => {
  it('+awm cumulative failed-call rate does not increase as priors accumulate', () => {
    // Many episodes hammering the same failing (tool,path): priors should let +awm catch more.
    const episodes: Episode[] = [];
    for (let i = 0; i < 20; i++) {
      episodes.push({
        id: i,
        calls: [
          call('Bash', 'repeat', 'downstream_error', 0.5),
          call('Bash', 'repeat', 'downstream_error', 0.5),
          call('Bash', 'ok', null, 0.0),
        ],
      });
    }
    const awm = scoreConfigToolUse('regex+decode+awm', episodes);
    const first = awm.overTime[0]!.cumulativeFailedCallRate;
    const last = awm.overTime[awm.overTime.length - 1]!.cumulativeFailedCallRate;
    // The cumulative rate should bend DOWN (or stay flat), never climb, as memory fills in.
    expect(last).toBeLessThanOrEqual(first);
  });
});

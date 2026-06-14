/**
 * Run determinism (spec §4 reproducibility): the same seed must produce byte-identical JSON.
 * The JSON surface stabilises wall-clock latency, so two runs on the same seed match exactly.
 */

import { describe, it, expect } from 'vitest';
import { runBenchmark } from '../src/run.js';
import { toJSON } from '../src/report.js';

describe('determinism', () => {
  it('same seed -> byte-identical JSON', () => {
    const a = toJSON(runBenchmark({ seed: 42, episodes: 50 }));
    const b = toJSON(runBenchmark({ seed: 42, episodes: 50 }));
    expect(a).toBe(b);
  });

  it('different seeds -> different episode results', () => {
    const a = toJSON(runBenchmark({ seed: 1, episodes: 20 }));
    const b = toJSON(runBenchmark({ seed: 2, episodes: 20 }));
    expect(a).not.toBe(b);
  });

  it('JSON carries no raw wall-clock latency (latency fields are sentinel)', () => {
    const json = toJSON(runBenchmark({ seed: 42, episodes: 10 }));
    const parsed = JSON.parse(json) as {
      safety: { overall: { latencyP50Ms: number; latencyP95Ms: number } }[];
    };
    for (const s of parsed.safety) {
      expect(s.overall.latencyP50Ms).toBe(0);
      expect(s.overall.latencyP95Ms).toBe(0);
    }
  });
});

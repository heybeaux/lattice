/**
 * Report honesty (spec §1): every report MUST carry the SYNTHETIC data header and the
 * SYNTHETIC-STUB predictor label. This is a non-negotiable truth constraint.
 */

import { describe, it, expect } from 'vitest';
import { runBenchmark } from '../src/run.js';
import { toMarkdown, toJSON } from '../src/report.js';

describe('report honesty header', () => {
  const result = runBenchmark({ seed: 42, episodes: 10 });

  it('markdown leads with the SYNTHETIC data header', () => {
    const md = toMarkdown(result);
    expect(md).toContain('DATA: SYNTHETIC (no Sonder audit chain yet)');
  });

  it('markdown labels the predictor column SYNTHETIC-STUB', () => {
    const md = toMarkdown(result);
    expect(md).toContain('predictor: SYNTHETIC-STUB');
  });

  it('markdown shows both axes and the over-time slope', () => {
    const md = toMarkdown(result);
    expect(md).toContain('Safety floor');
    expect(md).toContain('Tool-use quality lift');
    expect(md).toContain('improves over time');
    expect(md).toContain('failed-call reduction');
  });

  it('JSON carries the honesty flags structurally', () => {
    const parsed = JSON.parse(toJSON(result)) as {
      honesty: { dataSource: string; dataHeader: string; predictorLabel: string };
    };
    expect(parsed.honesty.dataSource).toBe('SYNTHETIC');
    expect(parsed.honesty.dataHeader).toBe('DATA: SYNTHETIC (no Sonder audit chain yet)');
    expect(parsed.honesty.predictorLabel).toBe('predictor: SYNTHETIC-STUB');
  });
});

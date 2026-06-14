/**
 * Report emitters (spec §3, §4, §1 honesty). Two outputs from one `BenchmarkResult`:
 *
 *   - toMarkdown(result): human-readable report. MUST lead with the SYNTHETIC data header and
 *     the SYNTHETIC-STUB predictor label, then the safety confusion table (per config), the
 *     tool-use lift table (headline = failed-call reduction), and the episodes-over-time slope.
 *   - toJSON(result): JSON.stringify(result, null, 2), BYTE-STABLE for a fixed seed.
 *
 * Determinism: the only non-deterministic numbers in a run are the wall-clock latency
 * percentiles (Axis 1). `toJSON` rebuilds the result with those latency fields replaced by a
 * stable sentinel (`null`) so `aegis-bench run --seed 42` is byte-reproducible across machines.
 * `toMarkdown` prints the measured latency (rounded) for human eyes but is not the determinism
 * surface. Object key order is fixed by construction (we never iterate Maps into output).
 */

import type { BenchmarkResult, SafetyResult } from './run.js';
import type { SafetyMetrics } from './score/safety.js';
import type { ToolUseResult } from './score/tooluse.js';
import { AWM_LABEL } from './engines/awm-stub.js';

/** Latency sentinel written into the deterministic JSON surface (real ms is machine-variable).
 * Numeric 0 keeps the latency fields typed as number and matches stabiliseLatency. */
const LATENCY_SENTINEL = 0;

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function num(x: number, digits = 2): string {
  return x.toFixed(digits);
}

/** Render the per-config safety confusion table (Axis 1). */
function safetyTable(safety: readonly SafetyResult[]): string {
  const header =
    '| config | catch rate | false-pos rate | precision | F1 | p50 ms | p95 ms | TP | FP | TN | FN |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = safety.map((s) => {
    const m: SafetyMetrics = s.overall;
    return (
      `| \`${s.config}\` | ${pct(m.catchRate)} | ${pct(m.falsePositiveRate)} | ` +
      `${pct(m.precision)} | ${num(m.f1)} | ${num(m.latencyP50Ms, 3)} | ${num(m.latencyP95Ms, 3)} | ` +
      `${m.matrix.tp} | ${m.matrix.fp} | ${m.matrix.tn} | ${m.matrix.fn} |`
    );
  });
  return [header, sep, ...rows].join('\n');
}

/** Render the adversarial-only catch-rate lift (where +decode / +awm earn their keep). */
function adversarialTable(safety: readonly SafetyResult[]): string {
  const header = '| config | adversarial catch rate | adversarial false-pos rate |';
  const sep = '|---|---|---|';
  const rows = safety.map(
    (s) =>
      `| \`${s.config}\` | ${pct(s.adversarial.catchRate)} | ${pct(s.adversarial.falsePositiveRate)} |`,
  );
  return [header, sep, ...rows].join('\n');
}

/** Render the per-config tool-use lift table (Axis 2). Headline = failed-call reduction. */
function toolUseTable(toolUse: readonly ToolUseResult[]): string {
  const header =
    '| config | failed-call rate | **failed-call reduction** | success rate | mean retries | thrash avoided | wasted cost | false blocks |';
  const sep = '|---|---|---|---|---|---|---|---|';
  const rows = toolUse.map((t) => {
    const m = t.metrics;
    return (
      `| \`${m.config}\` | ${pct(m.failedCallRate)} | **${pct(m.failedCallReduction)}** | ` +
      `${pct(m.successRate)} | ${num(m.meanRetriesToSuccess)} | ${m.thrashEpisodesAvoided} | ` +
      `${m.wastedActionCost} | ${m.falseBlocks} (${pct(m.falseBlockRate)}) |`
    );
  });
  return [header, sep, ...rows].join('\n');
}

/**
 * Render the episodes-over-time slope (spec §3.3): cumulative failed-call rate as a function of
 * episode index, per config. A downward slope for `+awm` is the "improves over time" proof. We
 * sample a handful of checkpoints (start / quarter / half / three-quarter / end) to keep it
 * readable while still showing the trend.
 */
function overTimeTable(toolUse: readonly ToolUseResult[]): string {
  const sampleIdx = (len: number): number[] => {
    if (len <= 1) return [0];
    const checkpoints = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (len - 1)));
    return [...new Set(checkpoints)].sort((a, b) => a - b);
  };

  // All configs share the same episode count; use the first to pick checkpoints.
  const len = toolUse[0]?.overTime.length ?? 0;
  const idxs = sampleIdx(len);

  const header = `| config | ${idxs.map((i) => `ep ${i}`).join(' | ')} |`;
  const sep = `|---|${idxs.map(() => '---').join('|')}|`;
  const rows = toolUse.map((t) => {
    const cells = idxs.map((i) => {
      const pt = t.overTime[i];
      return pt ? pct(pt.cumulativeFailedCallRate) : '-';
    });
    return `| \`${t.metrics.config}\` | ${cells.join(' | ')} |`;
  });
  return [header, sep, ...rows].join('\n');
}

/** Human-readable markdown report. Leads with the honesty header (spec §1). */
export function toMarkdown(result: BenchmarkResult): string {
  const { metadata, honesty } = result;
  const lines: string[] = [];

  lines.push('# Aegis Benchmark Report');
  lines.push('');
  lines.push(`> **${honesty.dataHeader}**`);
  lines.push(`> **${honesty.predictorLabel}** (${AWM_LABEL})`);
  lines.push('>');
  lines.push(
    `> seed \`${metadata.seed}\` · ${metadata.episodes} episodes · stamp \`${metadata.timestamp}\``,
  );
  lines.push('');
  lines.push(
    'This benchmark measures whether running an agent\'s tool calls through the Aegis harness ' +
      'makes tool use measurably **better over time** — fewer failed calls, faster recovery, less ' +
      'thrash — without paying for it in latency or false blocks. Safety catch-rate is the ' +
      'secondary floor; tool-use lift is the north star. **All data is synthetic** until the ' +
      'Sonder audit chain can feed it real traces (`--source sonder`, gated on Phase 3.5).',
  );
  lines.push('');

  // ---- Axis 1 ----
  lines.push('## Axis 1 — Safety floor (confusion matrix, per config)');
  lines.push('');
  lines.push('`deny|ask` = intervened, `allow` = passed. Positive class = "must intervene".');
  lines.push('');
  lines.push(safetyTable(result.safety));
  lines.push('');
  lines.push('### Adversarial value-proof (catch-rate lift `regex → +decode → +awm`)');
  lines.push('');
  lines.push(adversarialTable(result.safety));
  lines.push('');

  // ---- Axis 2 ----
  lines.push('## Axis 2 — Tool-use quality lift (the north star)');
  lines.push('');
  lines.push(
    'Baseline is `none` (raw model, no harness). **Failed-call reduction** is the headline: the ' +
      'drop in failed calls vs `none`. Net friction = false blocks on good calls — it must stay ' +
      'low or the lift is fake.',
  );
  lines.push('');
  lines.push(toolUseTable(result.toolUse));
  lines.push('');

  // ---- Over time ----
  lines.push('### Lift over episodes seen (the "improves over time" slope)');
  lines.push('');
  lines.push(
    'Cumulative failed-call rate as the run progresses. As the `+awm` PriorStore accumulates ' +
      'per-(tool,path) fail-history across episodes, its predictor catches more — the rate should ' +
      'bend **down**. A flat line for `none`/`regex` is expected (no memory).',
  );
  lines.push('');
  lines.push(overTimeTable(result.toolUse));
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(
    `_Reproduce: \`aegis-bench run --seed ${metadata.seed} --episodes ${metadata.episodes}\`. ` +
      'Synthetic, seeded, byte-stable._',
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Byte-stable JSON. Replaces wall-clock latency percentiles with a stable sentinel so the
 * structural result is fully reproducible from `--seed`. Everything else is deterministic by
 * construction.
 */
export function toJSON(result: BenchmarkResult): string {
  const stable: BenchmarkResult = {
    ...result,
    safety: result.safety.map((s) => ({
      config: s.config,
      overall: stabiliseLatency(s.overall),
      regression: stabiliseLatency(s.regression),
      adversarial: stabiliseLatency(s.adversarial),
    })),
  };
  return JSON.stringify(stable, latencyReplacer, 2);
}

/** Return a SafetyMetrics with latency fields zeroed to the sentinel. */
function stabiliseLatency(m: SafetyMetrics): SafetyMetrics {
  return {
    ...m,
    latencyP50Ms: 0,
    latencyP95Ms: 0,
  };
}

/**
 * Replacer that also nulls any stray latency keys (defence-in-depth: ScoredCase latencies are
 * not in the result, but if a future field carries raw ms, this keeps JSON stable).
 */
function latencyReplacer(key: string, value: unknown): unknown {
  if ((key === 'latencyP50Ms' || key === 'latencyP95Ms' || key === 'latencyMs') && typeof value === 'number') {
    return LATENCY_SENTINEL;
  }
  return value;
}

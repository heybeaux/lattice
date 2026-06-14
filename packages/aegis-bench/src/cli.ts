#!/usr/bin/env node
/**
 * `aegis-bench` CLI (spec §4). Dependency-free arg parsing.
 *
 *   aegis-bench run [--seed N] [--episodes N] [--out DIR] [--format md|json|both]
 *
 * Defaults: --seed 42, --episodes 50, --out results, --format both.
 * Writes results/baseline-2026-06-14.{json,md} (filename derived from the spec date) and prints
 * a short summary to stdout. The JSON is byte-stable for a fixed seed (the committed baseline).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runBenchmark } from './run.js';
import { toMarkdown, toJSON } from './report.js';

/** The committed baseline artifact stem (spec §4 file layout). */
const BASELINE_STEM = 'baseline-2026-06-14';

type Format = 'md' | 'json' | 'both';

interface CliArgs {
  command: string;
  seed: number;
  episodes: number;
  out: string;
  format: Format;
}

const DEFAULTS = {
  seed: 42,
  episodes: 50,
  out: 'results',
  format: 'both' as Format,
};

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run',
    seed: DEFAULTS.seed,
    episodes: DEFAULTS.episodes,
    out: DEFAULTS.out,
    format: DEFAULTS.format,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--seed':
        args.seed = requireInt(argv[++i], '--seed');
        break;
      case '--episodes':
        args.episodes = requireInt(argv[++i], '--episodes');
        break;
      case '--out':
        args.out = requireValue(argv[++i], '--out');
        break;
      case '--format':
        args.format = requireFormat(argv[++i]);
        break;
      default:
        // Ignore the leading command token and any unknown flags' positional values.
        break;
    }
  }
  return args;
}

function requireValue(v: string | undefined, flag: string): string {
  if (v === undefined) {
    fail(`${flag} requires a value`);
  }
  return v;
}

function requireInt(v: string | undefined, flag: string): number {
  const raw = requireValue(v, flag);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    fail(`${flag} must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

function requireFormat(v: string | undefined): Format {
  const raw = requireValue(v, '--format');
  if (raw === 'md' || raw === 'json' || raw === 'both') return raw;
  fail(`--format must be one of md|json|both (got "${raw}")`);
}

function fail(message: string): never {
  process.stderr.write(`aegis-bench: ${message}\n`);
  process.exit(1);
}

function usage(): void {
  process.stdout.write(
    [
      'aegis-bench — benchmark whether the Aegis harness improves tool use over time.',
      '',
      'Usage:',
      '  aegis-bench run [--seed N] [--episodes N] [--out DIR] [--format md|json|both]',
      '',
      'Defaults: --seed 42 --episodes 50 --out results --format both',
      '',
      'All output is SYNTHETIC (no Sonder audit chain yet) and byte-stable for a fixed --seed.',
      '',
    ].join('\n'),
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const args = parseArgs(argv);
  if (args.command !== 'run') {
    fail(`unknown command "${args.command}" (expected "run")`);
  }

  const result = runBenchmark({ seed: args.seed, episodes: args.episodes });
  const outDir = resolve(process.cwd(), args.out);
  mkdirSync(outDir, { recursive: true });

  const written: string[] = [];
  if (args.format === 'json' || args.format === 'both') {
    const p = join(outDir, `${BASELINE_STEM}.json`);
    writeFileSync(p, toJSON(result) + '\n', 'utf8');
    written.push(p);
  }
  if (args.format === 'md' || args.format === 'both') {
    const p = join(outDir, `${BASELINE_STEM}.md`);
    writeFileSync(p, toMarkdown(result), 'utf8');
    written.push(p);
  }

  printSummary(args, result, written);
}

function printSummary(
  args: CliArgs,
  result: ReturnType<typeof runBenchmark>,
  written: readonly string[],
): void {
  const lines: string[] = [];
  lines.push(result.honesty.dataHeader);
  lines.push(result.honesty.predictorLabel);
  lines.push(`seed=${args.seed} episodes=${args.episodes}`);
  lines.push('');
  lines.push('Tool-use lift (failed-call rate → reduction vs none):');
  for (const t of result.toolUse) {
    const m = t.metrics;
    lines.push(
      `  ${m.config.padEnd(18)} ${(m.failedCallRate * 100).toFixed(1).padStart(5)}%  ` +
        `reduction ${(m.failedCallReduction * 100).toFixed(1).padStart(5)}%  ` +
        `false-blocks ${m.falseBlocks}`,
    );
  }
  lines.push('');
  lines.push('Safety floor (catch / false-pos, per real config):');
  for (const s of result.safety) {
    lines.push(
      `  ${s.config.padEnd(18)} catch ${(s.overall.catchRate * 100).toFixed(1).padStart(5)}%  ` +
        `fp ${(s.overall.falsePositiveRate * 100).toFixed(1).padStart(5)}%`,
    );
  }
  lines.push('');
  lines.push(`Wrote: ${written.join(', ')}`);
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

main();

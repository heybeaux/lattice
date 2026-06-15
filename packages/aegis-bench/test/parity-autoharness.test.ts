/**
 * PARITY conformance test: AutoHarness tests/test_risk.py -> Aegis engine.
 *
 * Loads the cases AST-extracted from AutoHarness's own test_risk.py (committed fixture),
 * replays each through our `evaluate`, and reports parity. Failures are FINDINGS
 * (documented divergences), so this test does NOT fail the build on a divergence — it
 * writes a JSON report and a human summary that the results markdown is built from.
 *
 * Run: pnpm --filter @heybeaux/lattice-aegis-bench test parity-autoharness
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runParity, type RawCase } from '../src/parity.js';

/** Mask secret-shaped tokens so the committed JSON artifact carries no live-looking creds. */
function redactSecrets(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9]+/g, 'sk-[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_[REDACTED]')
    .replace(/AKIA[A-Z0-9]+/g, 'AKIA[REDACTED]')
    .replace(/xoxb-[A-Za-z0-9-]+/g, 'xoxb-[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, '[REDACTED PRIVATE KEY BLOCK]')
    .replace(/(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/g, '$1://user:[REDACTED]@');
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'autoharness-test_risk-cases.json');
// AutoHarness HEAD the fixture was extracted from (recorded for provenance).
const SOURCE_SHA = '3561e468f9ca9f9bf282512e695bd32e4e90fef4';

describe('AutoHarness parity — tests/test_risk.py corpus', () => {
  const cases = JSON.parse(readFileSync(fixturePath, 'utf8')) as RawCase[];
  const report = runParity(cases, SOURCE_SHA);

  it('replays every extracted case (no silent drops)', () => {
    expect(report.results.length).toBe(cases.length);
    expect(report.applicable + report.excluded).toBe(cases.length);
  });

  it('writes a parity report artifact + prints summary', () => {
    const outDir = join(here, '..', 'results');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'parity-autoharness-2026-06-14.json');
    // Redact secret-shaped literals from the persisted artifact so the committed report
    // doesn't carry tokens (even AutoHarness's fake ones trip our own write-hook). The
    // verbatim inputs still live in the test fixture, which is what the harness runs on.
    const redacted = JSON.parse(JSON.stringify(report)) as typeof report;
    for (const r of redacted.results) {
      if (r.input?.command) r.input.command = redactSecrets(r.input.command);
      if (r.input?.content) r.input.content = redactSecrets(r.input.content);
    }
    writeFileSync(outPath, JSON.stringify(redacted, null, 2) + '\n', 'utf8');

    const fails = report.results.filter((r) => r.status === 'fail');
    const excl = report.results.filter((r) => r.status === 'excluded');

    // Emitted to test stdout so the run is self-documenting.

    console.log('\n=== AutoHarness parity: tests/test_risk.py ===');
    console.log(`source SHA      : ${report.sourceSha}`);
    console.log(`extracted cases : ${report.totalExtracted}`);
    console.log(`excluded        : ${report.excluded}`);
    console.log(`applicable      : ${report.applicable}`);
    console.log(`passed          : ${report.passed}`);
    console.log(`failed          : ${report.failed}`);
    console.log(`parity          : ${report.parityPct.toFixed(1)}%`);
    if (excl.length) {
      console.log('\n--- excluded (with reason) ---');
      for (const e of excl) console.log(`  ${e.id}\n      ${e.exclusionReason}`);
    }
    if (fails.length) {
      console.log('\n--- divergences (their-expected vs our-actual) ---');
      for (const f of fails) {
        const inp = f.input?.command ?? f.input?.paths?.join(',') ?? f.input?.content ?? '';
        console.log(
          `  ${f.id}\n      input   : [${f.input?.tool}] ${JSON.stringify(inp)}\n` +
            `      expected: ${f.expected?.join('|')}   actual: ${f.actual}`,
        );
      }
    }
    console.log(`\nreport written: ${outPath}\n`);

    expect(report.applicable).toBeGreaterThan(0);
  });
});

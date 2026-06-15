#!/usr/bin/env node
/**
 * The Aegis PreToolUse hook entry point.
 *
 * Claude Code runs this command and pipes the tool-call JSON to stdin. We read
 * stdin, map it to an Aegis ToolCall, evaluate the compiled rule packs, and signal
 * the verdict via exit code + stderr (see decide.ts).
 *
 * FAIL OPEN: any unexpected fault — empty/unparseable stdin, a rulepack load
 * failure, a bug here — logs to stderr and exits 0. A broken governance hook must
 * never brick the user's Claude Code session; only a clean Aegis `deny` blocks.
 */

import { evaluate } from '@heybeaux/lattice-aegis';
import { readStdin, toToolCall } from './stdin.js';
import { loadAllPacks } from './rules.js';
import { decide } from './decide.js';

function main(): void {
  const input = readStdin().trim();
  if (input === '') {
    process.stderr.write('[Aegis] empty stdin; allowing (fail-open)\n');
    process.exit(0);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    process.stderr.write('[Aegis] unparseable stdin JSON; allowing (fail-open)\n');
    process.exit(0);
  }

  const call = toToolCall(raw);
  const evaluation = evaluate(call, loadAllPacks());
  const { exitCode, stderr } = decide(evaluation);
  if (stderr) process.stderr.write(stderr + '\n');
  process.exit(exitCode);
}

try {
  main();
} catch (err) {
  // Fail OPEN on any unexpected fault — never block the session on a hook bug.
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[Aegis] hook error (fail-open): ${msg}\n`);
  process.exit(0);
}

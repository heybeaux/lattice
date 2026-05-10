#!/usr/bin/env node
/**
 * Persistent Circuit Breaker Example
 *
 * Demonstrates CircuitBreaker with JsonFileBackend so circuit state
 * survives process restarts.
 *
 * Run: npx tsx examples/persistent-breaker.ts
 *
 * After the first run, inspect ./tmp/circuit-state.json to see the
 * persisted state. Run again to see that the state is restored.
 */

import * as fs from 'fs';
import { CircuitBreaker } from '../packages/core/src/index.js';
import { JsonFileBackend } from '../packages/core/src/breaker/persistence.js';

const STATE_FILE = './tmp/circuit-state.json';

// Ensure the tmp directory exists
if (!fs.existsSync('./tmp')) {
  fs.mkdirSync('./tmp', { recursive: true });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const backend = new JsonFileBackend(STATE_FILE, /* syncIntervalMs */ 0);

const breaker = new CircuitBreaker({
  id: 'example-breaker',
  failureThreshold: 3,
  recoveryTimeoutMs: 5000, // 5s for demo purposes
  persistence: backend,
});

// Restore persisted state from a previous run (if any).
// In production: call this once on startup before using the breaker.
await breaker.restoreState();

// ─── Show initial state ───────────────────────────────────────────────────────

const initialMetrics = breaker.metrics;
console.log('=== Persistent Circuit Breaker Demo ===\n');
console.log(`State file: ${STATE_FILE}`);
console.log(`Restored state: ${initialMetrics.state}`);
console.log(
  `Consecutive failures on restore: ${initialMetrics.consecutiveFailures}`,
);
console.log(`Times opened (all-time): ${initialMetrics.timesOpened}\n`);

// ─── Simulate some operations ─────────────────────────────────────────────────

/**
 * A mock "provider" that fails on demand.
 */
async function callProvider(shouldFail: boolean): Promise<string> {
  if (shouldFail) throw new Error('Provider unreachable');
  return 'result-ok';
}

async function validatedCall(shouldFail: boolean): Promise<void> {
  if (!breaker.canAttempt()) {
    console.log('  [SKIP] Circuit is open — fast-failing without calling provider');
    return;
  }

  try {
    const result = await callProvider(shouldFail);
    breaker.recordSuccess();
    console.log(`  [OK]   Provider returned: ${result} — state: ${breaker.state}`);
  } catch (err) {
    breaker.recordFailure();
    console.log(
      `  [FAIL] Provider error: ${(err as Error).message} — state: ${breaker.state}`,
    );
  }
}

// Two successes
console.log('--- Two successful calls ---');
await validatedCall(false);
await validatedCall(false);

// Three failures trigger the breaker
console.log('\n--- Three consecutive failures (threshold=3) ---');
await validatedCall(true);
await validatedCall(true);
await validatedCall(true);

// Circuit is now open — next call is fast-failed
console.log('\n--- Call while circuit is open ---');
await validatedCall(false);

// ─── Flush state to disk and show the file ────────────────────────────────────

await backend.flush();

console.log('\n--- Persisted state file ---');
const raw = fs.readFileSync(STATE_FILE, 'utf-8');
const entries: Array<[string, unknown]> = JSON.parse(raw);
for (const [id, state] of entries) {
  console.log(`  Breaker "${id}":`, JSON.stringify(state, null, 4));
}

console.log('\n--- Final metrics ---');
const m = breaker.metrics;
console.log(`  state:               ${m.state}`);
console.log(`  consecutiveFailures: ${m.consecutiveFailures}`);
console.log(`  timesOpened:         ${m.timesOpened}`);
console.log(`  totalAttempts:       ${m.totalAttempts}`);
console.log(`  totalSuccesses:      ${m.totalSuccesses}`);
console.log(`  totalFailures:       ${m.totalFailures}`);

console.log(
  '\nTip: Run this script again to see the state restored from disk.',
);

// Clean up backend resources
backend.dispose();

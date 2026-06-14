/**
 * @heybeaux/lattice-core/test-helpers — CI-only test utilities for L0 custom
 * policy rules.
 *
 * This module is intentionally NOT exported from the package root. It is loaded
 * via the `./test-helpers` subpath so that production runtime code in
 * `@heybeaux/lattice-core` cannot accidentally pull in the fuzz harness
 * (the harness is allowed to allocate, randomize, and stringify freely; the
 * runtime is not).
 *
 * The R9 spec says: "Determinism fuzz is CI-only. Custom rules MUST pass a
 * 100-iteration determinism fuzz check exposed via
 * `verifyCustomRuleDeterminism(rule, fixtures)` from
 * `@heybeaux/lattice-core/test-helpers`. Projects that ship custom rules MUST
 * run this in their CI as a release gate."
 *
 * The harness has two modes:
 *
 *  1. User supplies `fixtures`: the rule is evaluated twice on each fixture
 *     and the boolean outputs are asserted to agree.
 *  2. User omits `fixtures` (the default): the harness generates 100 random
 *     `StateContract` shapes by mutating a seed contract, then runs the same
 *     two-pass agreement check.
 *
 * The RNG uses an explicit seed (default: `0x1234`) so failures are
 * reproducible from the harness output. The seed is exposed as a config
 * option for projects that want CI determinism across runs.
 */

import type { StateContract } from './contract/types.js';
import type { PolicyRule } from './breaker/types.js';

/**
 * Configuration for {@link verifyCustomRuleDeterminism}.
 */
export interface VerifyCustomRuleOptions {
  /**
   * Explicit fixtures to evaluate. When omitted, the harness generates
   * {@link iterations} random contract shapes from a fixed-seed RNG.
   */
  fixtures?: readonly StateContract[];
  /** Number of random fixtures to generate when {@link fixtures} is absent. Default: 100 */
  iterations?: number;
  /** RNG seed for reproducible generation. Default: 0x1234 */
  seed?: number;
}

/**
 * Result of a determinism fuzz run.
 *
 * `passed === true` iff every fixture produced the same boolean on both
 * evaluations. On failure, `offendingFixture` carries the contract that
 * produced disagreement (or threw inconsistently) so the failing CI run
 * can attach it as a regression fixture.
 */
export interface DeterminismCheckResult {
  passed: boolean;
  fixtureCount: number;
  /** First fixture that produced disagreement, if any. */
  offendingFixture?: StateContract;
  /** Difference summary for the offending fixture. */
  reason?: string;
}

/**
 * Run a 2× determinism check on a `'custom'` policy rule.
 *
 * For each fixture (user-supplied or generated), evaluates the rule twice
 * and asserts the boolean outputs (or thrown errors) agree. Disagreement
 * indicates non-determinism (`Date.now()`, `Math.random()`, external state)
 * — the offending fixture is returned for inclusion as a regression test.
 *
 * The harness is **synchronous** because R5 mandates that custom rules are
 * pure + sync. If `evaluate` returns a Promise, that itself is a
 * non-determinism red flag and the harness reports failure.
 *
 * @param rule - A `'custom'` policy rule (other kinds throw at compile time).
 * @param opts - Optional fixtures, iteration count, RNG seed.
 * @returns A {@link DeterminismCheckResult}.
 *
 * @example
 *   // In CI, before publishing:
 *   const r = verifyCustomRuleDeterminism(myCustomRule);
 *   if (!r.passed) {
 *     console.error('Non-deterministic rule:', r.reason);
 *     process.exit(1);
 *   }
 */
export function verifyCustomRuleDeterminism(
  rule: PolicyRule,
  opts?: VerifyCustomRuleOptions,
): DeterminismCheckResult {
  if (rule.kind !== 'custom') {
    throw new Error(
      `verifyCustomRuleDeterminism: rule '${rule.id}' is kind '${rule.kind}'; only 'custom' rules need the fuzz check.`,
    );
  }
  if (typeof rule.evaluate !== 'function') {
    throw new Error(
      `verifyCustomRuleDeterminism: rule '${rule.id}' has no evaluate function.`,
    );
  }

  const iterations = opts?.iterations ?? 100;
  const seed = opts?.seed ?? 0x1234;
  const fixtures = opts?.fixtures ?? generateFixtures(iterations, seed);

  for (const fixture of fixtures) {
    const [a, errA] = safeEval(rule.evaluate, fixture);
    const [b, errB] = safeEval(rule.evaluate, fixture);

    // Both threw → check the error messages agree. We don't deep-compare the
    // error chain (most LLM-host errors include a stack with file:line which
    // varies across runs), just the message string.
    if (errA && errB) {
      if (errA.message !== errB.message) {
        return {
          passed: false,
          fixtureCount: fixtures.length,
          offendingFixture: fixture,
          reason: `evaluate threw different errors on two runs: '${errA.message}' vs '${errB.message}'`,
        };
      }
      continue;
    }
    if (errA && !errB) {
      return {
        passed: false,
        fixtureCount: fixtures.length,
        offendingFixture: fixture,
        reason: `evaluate threw on first run ('${errA.message}') but returned on second`,
      };
    }
    if (!errA && errB) {
      return {
        passed: false,
        fixtureCount: fixtures.length,
        offendingFixture: fixture,
        reason: `evaluate returned on first run but threw on second ('${errB.message}')`,
      };
    }
    if (a !== b) {
      return {
        passed: false,
        fixtureCount: fixtures.length,
        offendingFixture: fixture,
        reason: `evaluate returned different values on two runs: ${String(a)} vs ${String(b)}`,
      };
    }
  }

  return { passed: true, fixtureCount: fixtures.length };
}

function safeEval(
  evaluate: (c: StateContract) => unknown,
  fixture: StateContract,
): [unknown, Error | null] {
  try {
    return [evaluate(fixture), null];
  } catch (err) {
    return [undefined, err instanceof Error ? err : new Error(String(err))];
  }
}

/**
 * Build N synthetic `StateContract` fixtures from a deterministic seed.
 *
 * The shape walks the typical L0 attack surface — `outputs.payload.tool`,
 * `outputs.payload.recipient`, nested arrays, mixed types — so a custom rule
 * that branches on those paths is exercised broadly. We do NOT round-trip
 * through `createContract` (that hits the ULID generator, which is itself
 * non-deterministic) — the fixtures are plain objects that satisfy the
 * `StateContract` shape.
 */
function generateFixtures(iterations: number, seed: number): StateContract[] {
  const rng = mulberry32(seed);
  const out: StateContract[] = [];

  const TOOLS = ['gmail_send', 'web_search', 'calendar_create', 'unknown_tool', null, undefined];
  const RECIPIENTS = ['a@b.com', 'admin@example.com', '', null, undefined];
  const STRINGS = ['hello', 'world', '', 'SSN: 123-45-6789', 'normal text'];

  for (let i = 0; i < iterations; i++) {
    const tool = TOOLS[Math.floor(rng() * TOOLS.length)];
    const recipient = RECIPIENTS[Math.floor(rng() * RECIPIENTS.length)];
    const body = STRINGS[Math.floor(rng() * STRINGS.length)];
    const budget = Math.floor(rng() * 1000);

    out.push({
      id: `fixture-${i}`,
      schemaVersion: '0.1.0',
      traceId: `trace-${i}`,
      parentIds: [],
      fromAgent: 'fuzz',
      toAgent: null,
      timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      inputs: { payload: { topic: `topic-${i}` }, contentType: 'application/json' },
      decisions: [],
      outputs: {
        payload: { tool, recipient, body, budget },
        contentType: 'application/json',
      },
      constraints: [],
      assumptions: [],
      budget: { tokensUsed: budget, callsMade: 0, wallClockMs: 0 },
      metadata: {},
    } as unknown as StateContract);
  }

  return out;
}

/**
 * Mulberry32 — a small, seedable PRNG. Deterministic across Node runtimes,
 * adequate for fuzz generation (NOT for cryptography). Returns floats in
 * `[0, 1)` like `Math.random()`.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

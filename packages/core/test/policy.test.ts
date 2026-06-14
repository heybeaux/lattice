import { describe, it, expect, vi, afterEach } from 'vitest';
import { createContract } from '../src/contract/factory.js';
import type { StateContract } from '../src/contract/types.js';
import type { PolicyRule, PolicyRuleSet } from '../src/breaker/types.js';
import {
  compilePolicyRuleSet,
  evaluatePolicy,
  evaluateRule,
  firstFailure,
  formatPolicyDenyReason,
} from '../src/breaker/policy.js';

// Tiny factory so tests don't repeat the boilerplate. The contract used by
// L0 tests carries `outputs.payload.tool` etc., which the rules target.
function mkContract(payload: unknown, extras?: Partial<StateContract>): StateContract {
  const base = createContract({
    fromAgent: 'test-agent',
    inputs: { topic: 'unit-test' },
    outputs: payload as Record<string, unknown>,
    budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
  });
  return { ...base, ...extras } as StateContract;
}

function mkSet(rules: PolicyRule[], id = 'test-set', version = '1'): PolicyRuleSet {
  return { id, version, rules };
}

describe('compilePolicyRuleSet — R9 construction validation', () => {
  it('compiles a minimal empty rule set', () => {
    const c = compilePolicyRuleSet(mkSet([]));
    expect(c.id).toBe('test-set');
    expect(c.version).toBe('1');
    expect(c.rules).toEqual([]);
  });

  it('throws on non-object set', () => {
    // @ts-expect-error — runtime guard
    expect(() => compilePolicyRuleSet(null)).toThrow(/must be an object/);
    // @ts-expect-error — runtime guard
    expect(() => compilePolicyRuleSet('not-a-set')).toThrow(/must be an object/);
  });

  it('throws on missing id', () => {
    // @ts-expect-error — runtime guard
    expect(() => compilePolicyRuleSet({ version: '1', rules: [] })).toThrow(/id must be/);
    // @ts-expect-error — runtime guard
    expect(() => compilePolicyRuleSet({ id: '', version: '1', rules: [] })).toThrow(/id must be/);
  });

  it('throws on missing version', () => {
    // @ts-expect-error — runtime guard
    expect(() => compilePolicyRuleSet({ id: 'x', rules: [] })).toThrow(/version must be/);
  });

  it('throws on non-array rules', () => {
    // @ts-expect-error — runtime guard
    expect(() => compilePolicyRuleSet({ id: 'x', version: '1', rules: {} })).toThrow(/rules must be an array/);
  });

  it('throws on duplicate rule IDs', () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          { id: 'r1', description: 'a', jsonpath: '$.a', kind: 'required' },
          { id: 'r1', description: 'b', jsonpath: '$.b', kind: 'required' },
        ]),
      ),
    ).toThrow(/duplicate rule id 'r1'/);
  });

  it('throws on rule missing id', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      compilePolicyRuleSet(mkSet([{ description: 'a', jsonpath: '$.a', kind: 'required' }])),
    ).toThrow(/rule.id must be/);
  });

  it('throws on rule missing description', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      compilePolicyRuleSet(mkSet([{ id: 'r', jsonpath: '$.a', kind: 'required' }])),
    ).toThrow(/missing description/);
  });

  it('throws on rule missing jsonpath', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      compilePolicyRuleSet(mkSet([{ id: 'r', description: 'd', kind: 'required' }])),
    ).toThrow(/missing jsonpath/);
  });

  it('throws on rule jsonpath outside subset', () => {
    expect(() =>
      compilePolicyRuleSet(mkSet([{ id: 'r', description: 'd', jsonpath: '$..a', kind: 'required' }])),
    ).toThrow(/invalid jsonpath/);
  });

  it('throws on allowlist without values', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      compilePolicyRuleSet(mkSet([{ id: 'r', description: 'd', jsonpath: '$.a', kind: 'allowlist' }])),
    ).toThrow(/must define values/);
  });

  it('throws on denylist without values', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      compilePolicyRuleSet(mkSet([{ id: 'r', description: 'd', jsonpath: '$.a', kind: 'denylist' }])),
    ).toThrow(/must define values/);
  });

  it('throws on regex-deny with invalid regex', () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'regex-deny',
            pattern: '(',
          },
        ]),
      ),
    ).toThrow(/invalid regex/);
  });

  it('throws on numeric-bound with invalid op', () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'numeric-bound',
            // @ts-expect-error — runtime guard
            op: '!=',
            value: 1,
          },
        ]),
      ),
    ).toThrow(/invalid numeric-bound op/);
  });

  it('throws on numeric-bound with non-numeric value', () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'numeric-bound',
            op: '<=',
            // @ts-expect-error — runtime guard
            value: 'big',
          },
        ]),
      ),
    ).toThrow(/must be a finite number/);
  });

  it('throws on numeric-bound NaN', () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'numeric-bound',
            op: '<=',
            value: NaN,
          },
        ]),
      ),
    ).toThrow(/must be a finite number/);
  });

  it('throws on custom without function', () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'custom',
            // @ts-expect-error — runtime guard
            evaluate: 'not-a-function',
          },
        ]),
      ),
    ).toThrow(/evaluate must be a function/);
  });

  it('throws on conditional missing when/then', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      compilePolicyRuleSet(
        mkSet([{ id: 'r', description: 'd', jsonpath: '$.a', kind: 'conditional' }]),
      ),
    ).toThrow(/must define both 'when' and 'then'/);
  });

  it('throws when conditional rule jsonpath != when.jsonpath', () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'conditional',
            when: { jsonpath: '$.b', predicate: 'resolves' },
            then: { jsonpath: '$.c', predicate: 'resolves' },
          },
        ]),
      ),
    ).toThrow(/jsonpath must equal when.jsonpath/);
  });

  it('throws on conditional with bad when predicate', () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'conditional',
            // @ts-expect-error — runtime guard
            when: { jsonpath: '$.a', predicate: 'not-a-pred' },
            then: { jsonpath: '$.b', predicate: 'resolves' },
          },
        ]),
      ),
    ).toThrow(/'when.predicate' must be/);
  });

  it("throws on conditional 'matches' without value", () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'conditional',
            // @ts-expect-error — runtime guard
            when: { jsonpath: '$.a', predicate: 'matches' },
            then: { jsonpath: '$.b', predicate: 'resolves' },
          },
        ]),
      ),
    ).toThrow(/value' must be a string for predicate 'matches'/);
  });

  it('throws on conditional with invalid then.jsonpath', () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'conditional',
            when: { jsonpath: '$.a', predicate: 'resolves' },
            then: { jsonpath: '$..b', predicate: 'resolves' },
          },
        ]),
      ),
    ).toThrow(/'then.jsonpath' invalid/);
  });

  it("throws when conditional when is null", () => {
    // The "must define both 'when' and 'then'" check (which treats `null`
    // as undefined-ish) fires before the dedicated object guard.
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'conditional',
            // @ts-expect-error — runtime guard
            when: null,
            then: { jsonpath: '$.b', predicate: 'resolves' },
          },
        ]),
      ),
    ).toThrow(/must define both 'when' and 'then'/);
  });

  it('throws when conditional then is a primitive (typed predicate guard)', () => {
    // The rule-level jsonpath-mismatch check only fires on `when`, so a
    // primitive `then` flows into `compilePredicate('then', ...)` directly.
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'conditional',
            when: { jsonpath: '$.a', predicate: 'resolves' },
            // @ts-expect-error — runtime guard
            then: 'not-an-object',
          },
        ]),
      ),
    ).toThrow(/'then' must be an object/);
  });

  it("throws on conditional then.jsonpath not a string", () => {
    expect(() =>
      compilePolicyRuleSet(
        mkSet([
          {
            id: 'r',
            description: 'd',
            jsonpath: '$.a',
            kind: 'conditional',
            when: { jsonpath: '$.a', predicate: 'resolves' },
            // @ts-expect-error — runtime guard
            then: { jsonpath: 123, predicate: 'resolves' },
          },
        ]),
      ),
    ).toThrow(/'then.jsonpath' must be a string/);
  });

  it('throws on unknown rule kind', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      compilePolicyRuleSet(mkSet([{ id: 'r', description: 'd', jsonpath: '$.a', kind: 'magic' }])),
    ).toThrow(/unknown rule kind/);
  });

  it('throws on rule not an object', () => {
    // @ts-expect-error — runtime guard
    expect(() => compilePolicyRuleSet(mkSet([null]))).toThrow(/rule must be an object/);
  });

  describe('R10 large-set warning', () => {
    afterEach(() => vi.restoreAllMocks());

    it('emits a console.warn for >100 rules', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const rules: PolicyRule[] = [];
      for (let i = 0; i < 101; i++) {
        rules.push({ id: `r${i}`, description: 'd', jsonpath: '$.a', kind: 'required' });
      }
      compilePolicyRuleSet(mkSet(rules));
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/has 101 rules/);
    });

    it('does NOT warn at 100 rules', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const rules: PolicyRule[] = [];
      for (let i = 0; i < 100; i++) {
        rules.push({ id: `r${i}`, description: 'd', jsonpath: '$.a', kind: 'required' });
      }
      compilePolicyRuleSet(mkSet(rules));
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('evaluatePolicy — allowlist', () => {
  const rules: PolicyRule[] = [
    {
      id: 'tool_in_allowlist',
      description: 'tool must be on allowlist',
      jsonpath: '$.outputs.payload.tool',
      kind: 'allowlist',
      values: ['web_search', 'gmail_send'],
    },
  ];

  it('passes when value is in set', () => {
    const c = mkContract({ tool: 'web_search' });
    const [row] = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    expect(row.outcome).toBe('pass');
    expect(row.kind).toBe('allowlist');
    expect(row.ruleId).toBe('tool_in_allowlist');
    expect(row.jsonpath).toBe('$.outputs.payload.tool');
  });

  it('fails when value is not in set', () => {
    const c = mkContract({ tool: 'nuke' });
    const [row] = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toMatch(/not in allowlist/);
  });

  it('fails when value is non-string (allowlists are string sets)', () => {
    const c = mkContract({ tool: 123 });
    const [row] = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    expect(row.outcome).toBe('fail');
  });

  it('fails when path does not resolve (defensive default)', () => {
    const c = mkContract({});
    const [row] = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toBe('jsonpath did not resolve');
  });

  it('handles wildcards (every element must be in set)', () => {
    const set = mkSet([
      {
        id: 'tools_in_allowlist',
        description: 'every tool',
        jsonpath: '$.outputs.payload.tools[*]',
        kind: 'allowlist',
        values: ['a', 'b'],
      },
    ]);
    const passing = mkContract({ tools: ['a', 'b'] });
    const failing = mkContract({ tools: ['a', 'c'] });
    expect(evaluatePolicy(passing, compilePolicyRuleSet(set))[0].outcome).toBe('pass');
    expect(evaluatePolicy(failing, compilePolicyRuleSet(set))[0].outcome).toBe('fail');
  });
});

describe('evaluatePolicy — denylist', () => {
  const rules: PolicyRule[] = [
    {
      id: 'no_blocked_recipients',
      description: 'recipient must not be on blocklist',
      jsonpath: '$.outputs.payload.recipient',
      kind: 'denylist',
      values: ['blocked@example.com'],
    },
  ];

  it('passes when value is not in deny set', () => {
    const c = mkContract({ recipient: 'ok@example.com' });
    expect(evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)))[0].outcome).toBe('pass');
  });

  it('fails when value is in deny set', () => {
    const c = mkContract({ recipient: 'blocked@example.com' });
    const [row] = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toMatch(/present in denylist/);
  });

  it('passes when path does not resolve (R4)', () => {
    const c = mkContract({});
    expect(evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)))[0].outcome).toBe('pass');
  });

  it('passes when value is non-string (denylists are string sets)', () => {
    const c = mkContract({ recipient: 42 });
    expect(evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)))[0].outcome).toBe('pass');
  });
});

describe('evaluatePolicy — regex-deny', () => {
  const rules: PolicyRule[] = [
    {
      id: 'no_ssn',
      description: 'output must not contain SSN',
      jsonpath: '$.outputs.payload.body',
      kind: 'regex-deny',
      pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
      flags: 'g',
    },
  ];

  it('passes when body is clean', () => {
    const c = mkContract({ body: 'hello world' });
    expect(evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)))[0].outcome).toBe('pass');
  });

  it('fails when body matches deny regex', () => {
    const c = mkContract({ body: 'SSN: 123-45-6789' });
    const [row] = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toMatch(/deny pattern/);
  });

  it('stateful /g regex stays correct across evaluations', () => {
    const compiled = compilePolicyRuleSet(mkSet(rules));
    const c1 = mkContract({ body: 'no ssn here' });
    const c2 = mkContract({ body: '111-22-3333' });
    // Two consecutive evaluations: must NOT depend on lastIndex carry-over.
    expect(evaluatePolicy(c1, compiled)[0].outcome).toBe('pass');
    expect(evaluatePolicy(c2, compiled)[0].outcome).toBe('fail');
    expect(evaluatePolicy(c2, compiled)[0].outcome).toBe('fail');
  });

  it('passes on unresolved path (R4)', () => {
    expect(
      evaluatePolicy(mkContract({}), compilePolicyRuleSet(mkSet(rules)))[0].outcome,
    ).toBe('pass');
  });

  it('skips null values during scanning', () => {
    const c = mkContract({ body: null });
    expect(evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)))[0].outcome).toBe('pass');
  });
});

describe('evaluatePolicy — numeric-bound', () => {
  const mkRule = (op: '<=' | '<' | '>=' | '>' | '==', value: number): PolicyRule => ({
    id: `r-${op}`,
    description: 'bound',
    jsonpath: '$.outputs.payload.budget',
    kind: 'numeric-bound',
    op,
    value,
  });

  it('checks each operator', () => {
    const c = mkContract({ budget: 5 });
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('<=', 5)])).rules[0]).outcome).toBe('pass');
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('<=', 4)])).rules[0]).outcome).toBe('fail');
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('<', 6)])).rules[0]).outcome).toBe('pass');
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('<', 5)])).rules[0]).outcome).toBe('fail');
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('>=', 5)])).rules[0]).outcome).toBe('pass');
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('>=', 6)])).rules[0]).outcome).toBe('fail');
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('>', 4)])).rules[0]).outcome).toBe('pass');
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('>', 5)])).rules[0]).outcome).toBe('fail');
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('==', 5)])).rules[0]).outcome).toBe('pass');
    expect(evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('==', 4)])).rules[0]).outcome).toBe('fail');
  });

  it('fails when path resolves to non-number', () => {
    const c = mkContract({ budget: 'lots' });
    const row = evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('<=', 5)])).rules[0]);
    expect(row.outcome).toBe('fail');
    expect(row.detail).toBe('value is not numeric');
  });

  it('fails when value is NaN', () => {
    const c = mkContract({ budget: NaN });
    expect(
      evaluateRule(c, compilePolicyRuleSet(mkSet([mkRule('<=', 5)])).rules[0]).outcome,
    ).toBe('fail');
  });

  it('fails when path does not resolve', () => {
    expect(
      evaluateRule(mkContract({}), compilePolicyRuleSet(mkSet([mkRule('<=', 5)])).rules[0])
        .outcome,
    ).toBe('fail');
  });
});

describe('evaluatePolicy — required', () => {
  const rules: PolicyRule[] = [
    {
      id: 'has_recipient',
      description: 'recipient required',
      jsonpath: '$.outputs.payload.recipient',
      kind: 'required',
    },
  ];

  it('passes when present and non-null', () => {
    expect(
      evaluatePolicy(mkContract({ recipient: 'a@b.com' }), compilePolicyRuleSet(mkSet(rules)))[0].outcome,
    ).toBe('pass');
  });

  it('fails when missing', () => {
    const [row] = evaluatePolicy(mkContract({}), compilePolicyRuleSet(mkSet(rules)));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toBe('required path did not resolve');
  });

  it('fails when explicitly null', () => {
    const [row] = evaluatePolicy(
      mkContract({ recipient: null }),
      compilePolicyRuleSet(mkSet(rules)),
    );
    expect(row.outcome).toBe('fail');
    expect(row.detail).toBe('required path resolved to null');
  });
});

describe('evaluatePolicy — forbidden', () => {
  const rules: PolicyRule[] = [
    {
      id: 'no_raw_html',
      description: 'rawHtml forbidden',
      jsonpath: '$.outputs.payload.rawHtml',
      kind: 'forbidden',
    },
  ];

  it('passes when absent', () => {
    expect(
      evaluatePolicy(mkContract({}), compilePolicyRuleSet(mkSet(rules)))[0].outcome,
    ).toBe('pass');
  });

  it('passes when explicitly null', () => {
    expect(
      evaluatePolicy(mkContract({ rawHtml: null }), compilePolicyRuleSet(mkSet(rules)))[0].outcome,
    ).toBe('pass');
  });

  it('fails when present and non-null', () => {
    const [row] = evaluatePolicy(
      mkContract({ rawHtml: '<script>' }),
      compilePolicyRuleSet(mkSet(rules)),
    );
    expect(row.outcome).toBe('fail');
    expect(row.detail).toBe('forbidden path resolved to a value');
  });
});

describe('evaluatePolicy — conditional', () => {
  // Mirror Spec 3's `intent_planned_before_action` invariant:
  //   when $.intent.action resolves, then $.intent.step_trace_id resolves.
  const rule: PolicyRule = {
    id: 'intent_planned_before_action',
    description: 'every action must have a step_trace_id',
    jsonpath: '$.intent.action',
    kind: 'conditional',
    when: { jsonpath: '$.intent.action', predicate: 'resolves' },
    then: { jsonpath: '$.intent.step_trace_id', predicate: 'resolves' },
  };

  // The conditional rule reads top-level $.intent, which doesn't exist on
  // a default contract. `createContract` returns a frozen object, so we
  // build the contract as a plain object (with an `intent` slot at the
  // top level) and cast to `StateContract` — the rule only inspects fields
  // it cares about.
  function mkIntent(intent: unknown): StateContract {
    return {
      id: 'test-id',
      schemaVersion: '0.1.0',
      traceId: 'test-trace',
      parentIds: [],
      fromAgent: 't',
      toAgent: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      inputs: { payload: {}, contentType: 'application/json' },
      decisions: [],
      outputs: { payload: {}, contentType: 'application/json' },
      constraints: [],
      assumptions: [],
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      metadata: {},
      intent,
    } as unknown as StateContract;
  }

  it('passes vacuously when `when` is not satisfied', () => {
    const c = mkIntent({}); // no action -> when fails
    const [row] = evaluatePolicy(c, compilePolicyRuleSet(mkSet([rule])));
    expect(row.outcome).toBe('pass');
  });

  it('passes when both when and then are satisfied', () => {
    const c = mkIntent({ action: 'send-email', step_trace_id: 'step-1' });
    expect(evaluatePolicy(c, compilePolicyRuleSet(mkSet([rule])))[0].outcome).toBe('pass');
  });

  it('fails with R4 detail when when satisfied but then not', () => {
    const c = mkIntent({ action: 'send-email' });
    const [row] = evaluatePolicy(c, compilePolicyRuleSet(mkSet([rule])));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toBe('when-satisfied-then-failed:$.intent.step_trace_id');
  });

  it('treats null antecedent value as NOT resolving', () => {
    const c = mkIntent({ action: null });
    expect(evaluatePolicy(c, compilePolicyRuleSet(mkSet([rule])))[0].outcome).toBe('pass');
  });

  it("supports 'is-truthy' predicate", () => {
    const set = mkSet([
      {
        id: 'r',
        description: 'd',
        jsonpath: '$.flags.enabled',
        kind: 'conditional',
        when: { jsonpath: '$.flags.enabled', predicate: 'is-truthy' },
        then: { jsonpath: '$.flags.value', predicate: 'is-truthy' },
      },
    ]);
    const withFlags = (flags: Record<string, unknown>): StateContract =>
      ({ ...(mkIntent({}) as Record<string, unknown>), flags }) as StateContract;
    const passWhenFalse = withFlags({ enabled: 0 });
    const passBoth = withFlags({ enabled: 1, value: 'x' });
    const failConsequent = withFlags({ enabled: 1, value: '' });
    expect(evaluatePolicy(passWhenFalse, compilePolicyRuleSet(set))[0].outcome).toBe('pass');
    expect(evaluatePolicy(passBoth, compilePolicyRuleSet(set))[0].outcome).toBe('pass');
    expect(evaluatePolicy(failConsequent, compilePolicyRuleSet(set))[0].outcome).toBe('fail');
  });

  it("supports 'matches' predicate", () => {
    const set = mkSet([
      {
        id: 'r',
        description: 'd',
        jsonpath: '$.intent.tool',
        kind: 'conditional',
        when: { jsonpath: '$.intent.tool', predicate: 'matches', value: 'gmail_send' },
        then: { jsonpath: '$.intent.audit', predicate: 'matches', value: 'enabled' },
      },
    ]);
    const fired = mkIntent({ tool: 'gmail_send', audit: 'enabled' });
    const firedBad = mkIntent({ tool: 'gmail_send', audit: 'disabled' });
    const skipped = mkIntent({ tool: 'web_search' });
    expect(evaluatePolicy(fired, compilePolicyRuleSet(set))[0].outcome).toBe('pass');
    expect(evaluatePolicy(firedBad, compilePolicyRuleSet(set))[0].outcome).toBe('fail');
    expect(evaluatePolicy(skipped, compilePolicyRuleSet(set))[0].outcome).toBe('pass');
  });

  it("'matches' predicate rejects non-string values", () => {
    const set = mkSet([
      {
        id: 'r',
        description: 'd',
        jsonpath: '$.intent.tool',
        kind: 'conditional',
        when: { jsonpath: '$.intent.tool', predicate: 'matches', value: 'x' },
        then: { jsonpath: '$.intent.audit', predicate: 'resolves' },
      },
    ]);
    // Antecedent value is numeric — 'matches' should not coerce, so the rule
    // is treated as vacuously passing.
    const c = mkIntent({ tool: 42, audit: 'ok' });
    expect(evaluatePolicy(c, compilePolicyRuleSet(set))[0].outcome).toBe('pass');
  });
});

describe('evaluatePolicy — custom', () => {
  it('passes when evaluate returns true', () => {
    const set = mkSet([
      {
        id: 'custom-true',
        description: 'd',
        jsonpath: '$',
        kind: 'custom',
        evaluate: () => true,
      },
    ]);
    expect(evaluatePolicy(mkContract({}), compilePolicyRuleSet(set))[0].outcome).toBe('pass');
  });

  it('fails when evaluate returns false', () => {
    const set = mkSet([
      {
        id: 'custom-false',
        description: 'd',
        jsonpath: '$',
        kind: 'custom',
        evaluate: () => false,
      },
    ]);
    const [row] = evaluatePolicy(mkContract({}), compilePolicyRuleSet(set));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toBe('custom evaluate returned false');
  });

  it('fails when evaluate throws', () => {
    const set = mkSet([
      {
        id: 'custom-throws',
        description: 'd',
        jsonpath: '$',
        kind: 'custom',
        evaluate: () => {
          throw new Error('boom');
        },
      },
    ]);
    const [row] = evaluatePolicy(mkContract({}), compilePolicyRuleSet(set));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toMatch(/custom evaluate threw: boom/);
  });

  it('falls back to "unknown error" when thrown Error has empty message', () => {
    // Branch coverage for the `?? 'unknown error'` fallback in evalCustom.
    const set = mkSet([
      {
        id: 'custom-throws-empty',
        description: 'd',
        jsonpath: '$',
        kind: 'custom',
        evaluate: () => {
          // Throw a non-Error object with no .message — exercises the
          // `(err as Error).message ?? 'unknown error'` fallback path.
          throw { not: 'an-error' };
        },
      },
    ]);
    const [row] = evaluatePolicy(mkContract({}), compilePolicyRuleSet(set));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toMatch(/custom evaluate threw: unknown error/);
  });

  it('fails when evaluate returns non-boolean', () => {
    const set = mkSet([
      {
        id: 'custom-string',
        description: 'd',
        jsonpath: '$',
        kind: 'custom',
        // @ts-expect-error — host violating the contract
        evaluate: () => 'maybe',
      },
    ]);
    const [row] = evaluatePolicy(mkContract({}), compilePolicyRuleSet(set));
    expect(row.outcome).toBe('fail');
    expect(row.detail).toMatch(/non-boolean/);
  });

  it('receives the same contract reference', () => {
    let received: unknown = null;
    const set = mkSet([
      {
        id: 'r',
        description: 'd',
        jsonpath: '$',
        kind: 'custom',
        evaluate: (c) => {
          received = c;
          return true;
        },
      },
    ]);
    const c = mkContract({ x: 1 });
    evaluatePolicy(c, compilePolicyRuleSet(set));
    expect(received).toBe(c);
  });
});

describe('evaluatePolicy — multi-rule + helpers', () => {
  const rules: PolicyRule[] = [
    {
      id: 'tool_in_allowlist',
      description: 'd',
      jsonpath: '$.outputs.payload.tool',
      kind: 'allowlist',
      values: ['ok'],
    },
    {
      id: 'has_recipient',
      description: 'd',
      jsonpath: '$.outputs.payload.recipient',
      kind: 'required',
    },
  ];

  it('returns one row per rule in input order', () => {
    const c = mkContract({ tool: 'ok', recipient: 'a@b.com' });
    const rows = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    expect(rows.map((r) => r.ruleId)).toEqual(['tool_in_allowlist', 'has_recipient']);
    expect(rows.every((r) => r.outcome === 'pass')).toBe(true);
  });

  it('does NOT short-circuit on first failure', () => {
    const c = mkContract({ tool: 'bad' });
    const rows = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBe('fail');
    expect(rows[1].outcome).toBe('fail');
  });

  it('firstFailure surfaces the first failed row', () => {
    const c = mkContract({ tool: 'bad', recipient: 'a@b.com' });
    const rows = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    const first = firstFailure(rows);
    expect(first?.ruleId).toBe('tool_in_allowlist');
  });

  it('firstFailure returns undefined when all pass', () => {
    const c = mkContract({ tool: 'ok', recipient: 'a@b.com' });
    const rows = evaluatePolicy(c, compilePolicyRuleSet(mkSet(rules)));
    expect(firstFailure(rows)).toBeUndefined();
  });

  it('formatPolicyDenyReason matches R2', () => {
    const compiled = compilePolicyRuleSet(mkSet(rules, 'writing-pipeline-v1', '2026-05-11.1'));
    expect(formatPolicyDenyReason(compiled, 'tool_in_allowlist')).toBe(
      'policy-deny:writing-pipeline-v1@2026-05-11.1:tool_in_allowlist',
    );
  });

  it('determinism: same inputs produce identical rows (incl. detail)', () => {
    const c = mkContract({ tool: 'bad' });
    const compiled = compilePolicyRuleSet(mkSet(rules));
    const a = evaluatePolicy(c, compiled);
    const b = evaluatePolicy(c, compiled);
    expect(a).toEqual(b);
  });
});

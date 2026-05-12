import { describe, it, expect } from 'vitest';
import {
  TieredCircuitBreaker,
  createContract,
  wrapAgent,
  HandoffFailure,
} from '../src/index.js';
import type {
  PolicyRule,
  PolicyRuleSet,
  StateContract,
} from '../src/index.js';

const baseContract = (outputs: unknown): StateContract =>
  createContract({
    fromAgent: 'a',
    inputs: { goal: 'test' },
    outputs,
    budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
  });

const allowlistRule: PolicyRule = {
  id: 'allow-tool',
  description: 'tool must be in allowlist',
  jsonpath: '$.outputs.payload.tool',
  kind: 'allowlist',
  values: ['search', 'summarize'],
};

const passingRuleSet: PolicyRuleSet = {
  id: 'test-policy',
  version: '1.0.0',
  rules: [allowlistRule],
};

describe('L0 wired through TieredCircuitBreaker', () => {
  it('is a no-op when no policy is bound (no L0 in tiersRun)', async () => {
    const breaker = new TieredCircuitBreaker({ tier: 'L1' });
    const contract = baseContract({ tool: 'arbitrary' });
    const r = await breaker.validate(contract);
    expect(r.passed).toBe(true);
    expect(r.tiersRun).toEqual(['L1']);
    // No metadata.l0 stamped.
    expect((contract.metadata as Record<string, unknown>).l0).toBeUndefined();
  });

  it('runs L0 first when policy is bound and passes through to L1', async () => {
    const breaker = new TieredCircuitBreaker({
      tier: 'L1',
      policy: passingRuleSet,
    });
    const contract = baseContract({ tool: 'search' });
    const r = await breaker.validate(contract);
    expect(r.passed).toBe(true);
    expect(r.tiersRun).toEqual(['L0', 'L1']);

    // Evidence trail is stamped on the contract.
    const l0 = (contract.metadata as { l0?: Record<string, unknown> }).l0;
    expect(l0).toBeDefined();
    expect(l0!.ruleSetId).toBe('test-policy');
    expect(l0!.ruleSetVersion).toBe('1.0.0');
    expect(Array.isArray(l0!.evidence)).toBe(true);
    expect((l0!.evidence as unknown[]).length).toBe(1);
    expect((l0!.evidence as Array<{ outcome: string }>)[0].outcome).toBe('pass');
    expect(typeof l0!.durationMs).toBe('number');
  });

  it('returns policy-deny:<id>@<v>:<ruleId> on L0 failure and skips L1+', async () => {
    const breaker = new TieredCircuitBreaker({
      tier: 'L1',
      policy: passingRuleSet,
    });
    const contract = baseContract({ tool: 'unapproved' });
    const r = await breaker.validate(contract);
    expect(r.passed).toBe(false);
    expect(r.tier).toBe('L0');
    expect(r.tiersRun).toEqual(['L0']); // L1 NEVER ran
    expect(r.reason).toBe('policy-deny:test-policy@1.0.0:allow-tool');

    // Contract is marked rejected so downstream observers can tell.
    expect((contract.metadata as Record<string, unknown>).validationStatus).toBe(
      'rejected',
    );
    // Evidence is still attached for the audit trail.
    const l0 = (contract.metadata as { l0?: { evidence: Array<{ outcome: string }> } }).l0;
    expect(l0).toBeDefined();
    expect(l0!.evidence[0].outcome).toBe('fail');
  });

  it('L0 fail surfaces as HandoffFailure through wrapAgent (abort mode)', async () => {
    const agent = wrapAgent(
      async (_input: { goal: string }) => ({ tool: 'unapproved' }),
      {
        id: 'test-agent',
        breaker: {
          tier: 'L1',
          policy: passingRuleSet,
        },
      },
    );

    await expect(agent({ goal: 'pick a tool' })).rejects.toThrow(HandoffFailure);

    try {
      await agent({ goal: 'pick a tool' });
    } catch (err) {
      const hf = err as HandoffFailure;
      expect(hf.validation.tier).toBe('L0');
      expect(hf.validation.reason).toMatch(/^policy-deny:test-policy@1\.0\.0:allow-tool$/);
      expect(hf.validation.tiersRun).toEqual(['L0']);
      // Contract still carries the evidence row.
      const l0 = (hf.contract.metadata as { l0?: { evidence: Array<{ outcome: string }> } }).l0;
      expect(l0!.evidence[0].outcome).toBe('fail');
    }
  });

  it('compilePolicyRuleSet throws at construction on malformed policy', () => {
    const bad: PolicyRuleSet = {
      id: 'bad',
      version: '1',
      rules: [
        {
          id: 'broken',
          description: 'invalid path',
          jsonpath: 'no-dollar', // missing $
          kind: 'required',
        },
      ],
    };
    expect(() => new TieredCircuitBreaker({ policy: bad })).toThrow();
  });

  it('L0 pass + L1 fail produces tiersRun: ["L0", "L1"] with L1 reason', async () => {
    // L1 will fail because outputs is null (schema-invalid contract shape).
    const breaker = new TieredCircuitBreaker({
      tier: 'L1',
      policy: {
        id: 'test',
        version: '1',
        // A rule that resolves and passes — does not block L1.
        rules: [
          {
            id: 'always-pass',
            description: 'inputs payload required',
            jsonpath: '$.inputs.payload',
            kind: 'required',
          },
        ],
      },
    });

    // Build a contract that's structurally invalid for L1: schemaVersion
    // is a deliberately wrong shape (number instead of string). L0 still
    // passes because $.inputs.payload resolves. We're testing tier
    // ordering — concrete L1 details don't matter as long as it fails.
    const good = baseContract({ tool: 'search' });
    const bad: StateContract = {
      ...good,
      // Wrong type triggers the L1 schema validator.
      schemaVersion: 42 as unknown as string,
    };

    const r = await breaker.validate(bad);
    expect(r.passed).toBe(false);
    expect(r.tier).toBe('L1');
    expect(r.tiersRun).toEqual(['L0', 'L1']);
  });
});

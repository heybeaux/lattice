import { describe, it, expect, vi } from 'vitest';
import {
  TieredCircuitBreaker,
  wrapAgent,
  HandoffFailure,
  createContract,
} from '@heybeaux/lattice-core';
import type {
  PolicyRuleSet,
  StateContract,
  TieredValidationResult,
} from '@heybeaux/lattice-core';
import {
  wrapParliamentModel,
  buildGovernanceBlock,
  assertSonderEventSignable,
} from '../src/index.js';

// A representative writing-pipeline policy. Mirrors the canonical
// shape from openspec/changes/add-l0-policy-rules/design.md.
const writingPolicy: PolicyRuleSet = {
  id: 'writing-pipeline-v1',
  version: '2026-05-11.1',
  rules: [
    {
      id: 'tool-in-allowlist',
      description: 'tool must be in the approved allowlist',
      jsonpath: '$.outputs.payload.tool',
      kind: 'allowlist',
      values: ['search', 'summarize', 'draft'],
    },
    {
      id: 'tokens-under-budget',
      description: 'tokensUsed must not exceed 10000',
      jsonpath: '$.budget.tokensUsed',
      kind: 'numeric-bound',
      op: '<=',
      value: 10_000,
    },
  ],
};

describe('end-to-end: Parliament allowlist denies out-of-allowlist tool', () => {
  it('an L0 deny from wrapParliamentModel surfaces in the governance block', async () => {
    const modelCall = vi.fn().mockResolvedValue({ tool: 'unapproved-tool' });
    const wrapped = wrapParliamentModel(
      { id: 'researcher', role: 'proposer' },
      modelCall,
      {
        breaker: {
          tier: 'L1',
          policy: writingPolicy,
        },
        // Shadow mode lets us inspect the failed contract.
        shadowMode: true,
      },
    );

    const { contract, passed } = await wrapped('plan the writeup');
    expect(passed).toBe(false);

    // Re-run validation explicitly so we can capture the
    // TieredValidationResult that maps to this contract. The wrapper
    // already validated once; this is a deterministic re-validation
    // of the same contract.
    const breaker = new TieredCircuitBreaker({
      tier: 'L1',
      policy: writingPolicy,
    });
    // The wrapper-produced contract has metadata.l0 already; we want a
    // pristine validation, so clone the contract without it.
    const pristine: StateContract = {
      ...contract,
      metadata: { ...contract.metadata },
    };
    delete (pristine.metadata as Record<string, unknown>).l0;
    delete (pristine.metadata as Record<string, unknown>).validationStatus;
    const validation = await breaker.validate(pristine);

    expect(validation.passed).toBe(false);
    expect(validation.tier).toBe('L0');
    expect(validation.tiersRun).toEqual(['L0']);
    expect(validation.reason).toBe(
      'policy-deny:writing-pipeline-v1@2026-05-11.1:tool-in-allowlist',
    );

    const governance = buildGovernanceBlock(pristine, validation);
    expect(governance.tier).toBe('L0');
    expect(governance.verdict).toBe('fail');
    expect(governance.evidence).toHaveLength(2); // both rules produce rows
    expect(governance.evidence[0]).toMatchObject({
      ruleId: 'tool-in-allowlist',
      kind: 'allowlist',
      outcome: 'fail',
    });
    expect(governance.evidence[1]).toMatchObject({
      ruleId: 'tokens-under-budget',
      kind: 'numeric-bound',
      outcome: 'pass',
    });

    // L0-only deny is signable — the event itself documents the deny.
    expect(() => assertSonderEventSignable(governance)).not.toThrow();
  });

  it('an approved tool produces a sign-allowed L0+L1 governance block', async () => {
    const modelCall = vi.fn().mockResolvedValue({ tool: 'search' });
    const wrapped = wrapParliamentModel(
      { id: 'researcher', role: 'proposer' },
      modelCall,
      {
        breaker: {
          tier: 'L1',
          policy: writingPolicy,
        },
      },
    );

    const { contract, passed } = await wrapped('plan the writeup');
    expect(passed).toBe(true);

    const breaker = new TieredCircuitBreaker({
      tier: 'L1',
      policy: writingPolicy,
    });
    const pristine: StateContract = {
      ...contract,
      metadata: { ...contract.metadata },
    };
    delete (pristine.metadata as Record<string, unknown>).l0;
    delete (pristine.metadata as Record<string, unknown>).validationStatus;
    const validation = await breaker.validate(pristine);

    const governance = buildGovernanceBlock(pristine, validation);
    expect(governance.tier).toBe('L0+L1');
    expect(governance.verdict).toBe('pass');
    expect(governance.evidence.every(r => r.outcome === 'pass')).toBe(true);
    expect(() => assertSonderEventSignable(governance)).not.toThrow();
  });

  it('L0 deny in non-shadow (abort) mode throws HandoffFailure', async () => {
    const modelCall = vi.fn().mockResolvedValue({ tool: 'forbidden-tool' });
    const wrapped = wrapAgent(
      async (_prompt: string) => modelCall('plan'),
      {
        id: 'researcher',
        breaker: {
          tier: 'L1',
          policy: writingPolicy,
          onReject: 'abort',
        },
      },
    );
    await expect(wrapped('plan')).rejects.toThrow(HandoffFailure);
  });
});

describe('snapshot: rendered SonderEvent governance block', () => {
  // The snapshot is deterministic because:
  //   - L0 is pure + sync,
  //   - durationMs is excluded by stamping a fixed value,
  //   - evidence rows are pure (rule, contract) functions.
  // Locking the JSON shape protects downstream Sonder + signer code from
  // accidental refactors of the governance block format.

  it('mixed-pass/fail evidence rows render as a stable shape', () => {
    // Mixed: allowlist passes, numeric-bound fails (budget exceeded).
    const contract: StateContract = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      schemaVersion: '0.1.0',
      traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      parentIds: [],
      fromAgent: 'researcher',
      toAgent: null,
      timestamp: '2026-05-11T00:00:00.000Z',
      inputs: { payload: { goal: 'pick a tool' }, contentType: 'application/json' },
      decisions: [],
      outputs: { payload: { tool: 'search' }, contentType: 'application/json' },
      constraints: [],
      assumptions: [],
      budget: { tokensUsed: 12_000, callsMade: 1, wallClockMs: 5 },
      metadata: {
        l0: {
          ruleSetId: 'writing-pipeline-v1',
          ruleSetVersion: '2026-05-11.1',
          // durationMs is intentionally zeroed so the snapshot is stable.
          durationMs: 0,
          evidence: [
            {
              ruleId: 'tool-in-allowlist',
              kind: 'allowlist',
              outcome: 'pass',
              jsonpath: '$.outputs.payload.tool',
            },
            {
              ruleId: 'tokens-under-budget',
              kind: 'numeric-bound',
              outcome: 'fail',
              jsonpath: '$.budget.tokensUsed',
              detail: 'value 12000 violates <= 10000',
            },
          ],
        },
        validationStatus: 'rejected',
      },
    };

    const validation: TieredValidationResult = {
      passed: false,
      tier: 'L0',
      durationMs: 0, // zeroed for snapshot stability
      tiersRun: ['L0'],
      reason: 'policy-deny:writing-pipeline-v1@2026-05-11.1:tokens-under-budget',
    };

    const governance = buildGovernanceBlock(contract, validation);
    expect(governance).toMatchInlineSnapshot(`
      {
        "evidence": [
          {
            "jsonpath": "$.outputs.payload.tool",
            "kind": "allowlist",
            "outcome": "pass",
            "ruleId": "tool-in-allowlist",
          },
          {
            "detail": "value 12000 violates <= 10000",
            "jsonpath": "$.budget.tokensUsed",
            "kind": "numeric-bound",
            "outcome": "fail",
            "ruleId": "tokens-under-budget",
          },
        ],
        "policySet": "writing-pipeline-v1",
        "policySetVersion": "2026-05-11.1",
        "reason": "policy-deny:writing-pipeline-v1@2026-05-11.1:tokens-under-budget",
        "tier": "L0",
        "verdict": "fail",
      }
    `);
  });

  it('full L0+L1+L2 pass governance block matches snapshot', () => {
    const contract: StateContract = {
      ...createContract({
        fromAgent: 'researcher',
        inputs: { goal: 'g' },
        outputs: { tool: 'search' },
        budget: { tokensUsed: 100, callsMade: 1, wallClockMs: 4 },
      }),
      // Override the freshly-generated fields to stabilize the snapshot.
      id: '01TEST',
      traceId: '01TRACE',
      timestamp: '2026-05-11T00:00:00.000Z',
      metadata: {
        l0: {
          ruleSetId: 'p',
          ruleSetVersion: '1',
          durationMs: 0,
          evidence: [
            {
              ruleId: 'r1',
              kind: 'allowlist',
              outcome: 'pass',
              jsonpath: '$.outputs.payload.tool',
            },
          ],
        },
      },
    };

    const validation: TieredValidationResult = {
      passed: true,
      tier: 'L2',
      durationMs: 0,
      tiersRun: ['L0', 'L1', 'L2'],
      confidence: 0.93,
    };

    const governance = buildGovernanceBlock(contract, validation);
    expect(governance).toMatchInlineSnapshot(`
      {
        "evidence": [
          {
            "jsonpath": "$.outputs.payload.tool",
            "kind": "allowlist",
            "outcome": "pass",
            "ruleId": "r1",
          },
        ],
        "policySet": "p",
        "policySetVersion": "1",
        "tier": "L0+L1+L2",
        "verdict": "pass",
      }
    `);
  });
});

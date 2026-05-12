import { describe, it, expect } from 'vitest';
import {
  buildGovernanceBlock,
  assertSonderEventSignable,
  SignRefusedError,
  type SonderGovernanceBlock,
} from '../src/index.js';
import type {
  PolicyEvidenceRow,
  StateContract,
  TieredValidationResult,
} from '@heybeaux/lattice-core';

const baseContract = (
  metadata: Record<string, unknown> = {},
): StateContract => ({
  id: 'c1',
  schemaVersion: '0.1.0',
  traceId: 't',
  parentIds: [],
  fromAgent: 'a',
  toAgent: null,
  timestamp: '2026-05-11T00:00:00.000Z',
  inputs: { payload: {}, contentType: 'application/json' },
  decisions: [],
  outputs: { payload: { tool: 'search' }, contentType: 'application/json' },
  constraints: [],
  assumptions: [],
  budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
  metadata,
});

const passingEvidence: PolicyEvidenceRow[] = [
  {
    ruleId: 'tool-in-allowlist',
    kind: 'allowlist',
    outcome: 'pass',
    jsonpath: '$.outputs.payload.tool',
  },
];

const failingEvidence: PolicyEvidenceRow[] = [
  {
    ruleId: 'tool-in-allowlist',
    kind: 'allowlist',
    outcome: 'fail',
    jsonpath: '$.outputs.payload.tool',
    detail: 'value not in allowlist of 2',
  },
];

describe('buildGovernanceBlock', () => {
  it('joins tiers with "+" and copies L0 evidence + policy identifiers', () => {
    const contract = baseContract({
      l0: {
        ruleSetId: 'writing-pipeline',
        ruleSetVersion: '2026-05-11.1',
        evidence: passingEvidence,
        durationMs: 0.3,
      },
    });
    const validation: TieredValidationResult = {
      passed: true,
      tier: 'L1',
      durationMs: 5,
      tiersRun: ['L0', 'L1'],
    };

    const g = buildGovernanceBlock(contract, validation);
    expect(g.tier).toBe('L0+L1');
    expect(g.verdict).toBe('pass');
    expect(g.evidence).toEqual(passingEvidence);
    expect(g.policySet).toBe('writing-pipeline');
    expect(g.policySetVersion).toBe('2026-05-11.1');
    expect(g.reason).toBeUndefined();
  });

  it('falls back to validation.tier when tiersRun is absent', () => {
    // Pre-L0 callers may not set tiersRun yet.
    const contract = baseContract();
    const validation: TieredValidationResult = {
      passed: true,
      tier: 'L1',
      durationMs: 5,
    };
    const g = buildGovernanceBlock(contract, validation);
    expect(g.tier).toBe('L1');
    expect(g.evidence).toEqual([]);
    expect(g.policySet).toBeUndefined();
  });

  it('emits verdict="fail" and propagates the reject reason on failure', () => {
    const contract = baseContract({
      l0: {
        ruleSetId: 'writing-pipeline',
        ruleSetVersion: '2026-05-11.1',
        evidence: failingEvidence,
        durationMs: 0.3,
      },
      validationStatus: 'rejected',
    });
    const validation: TieredValidationResult = {
      passed: false,
      tier: 'L0',
      durationMs: 1,
      tiersRun: ['L0'],
      reason: 'policy-deny:writing-pipeline@2026-05-11.1:tool-in-allowlist',
    };

    const g = buildGovernanceBlock(contract, validation);
    // R8: L0 fail produces governance.tier = 'L0' — L1/L2/L3 do not appear.
    expect(g.tier).toBe('L0');
    expect(g.verdict).toBe('fail');
    expect(g.evidence).toEqual(failingEvidence);
    expect(g.reason).toBe(
      'policy-deny:writing-pipeline@2026-05-11.1:tool-in-allowlist',
    );
    expect(g.policySet).toBe('writing-pipeline');
  });

  it('produces empty evidence[] when L0 is not bound', () => {
    const contract = baseContract();
    const validation: TieredValidationResult = {
      passed: true,
      tier: 'L1',
      durationMs: 2,
      tiersRun: ['L1'],
    };
    const g = buildGovernanceBlock(contract, validation);
    expect(g.tier).toBe('L1');
    expect(g.evidence).toEqual([]);
    expect(g.policySet).toBeUndefined();
    expect(g.policySetVersion).toBeUndefined();
  });
});

describe('assertSonderEventSignable — Spec 1 R7', () => {
  it('refuses to sign when L1 ran but evidence is empty', () => {
    const g: SonderGovernanceBlock = {
      tier: 'L1',
      verdict: 'pass',
      evidence: [],
    };
    expect(() => assertSonderEventSignable(g)).toThrow(SignRefusedError);
    try {
      assertSonderEventSignable(g);
    } catch (err) {
      expect((err as SignRefusedError).code).toBe('l0-evidence-missing');
      expect((err as SignRefusedError).name).toBe('SignRefusedError');
    }
  });

  it('refuses to sign when L0+L1 ran but evidence is empty', () => {
    // Theoretically impossible but defensive — if a buggy adapter
    // produces this state, the signer is the backstop.
    const g: SonderGovernanceBlock = {
      tier: 'L0+L1',
      verdict: 'pass',
      evidence: [],
    };
    expect(() => assertSonderEventSignable(g)).toThrow(SignRefusedError);
  });

  it('refuses to sign when L2 or L3 ran without evidence', () => {
    expect(() =>
      assertSonderEventSignable({ tier: 'L1+L2', verdict: 'pass', evidence: [] }),
    ).toThrow(SignRefusedError);
    expect(() =>
      assertSonderEventSignable({ tier: 'L1+L3', verdict: 'pass', evidence: [] }),
    ).toThrow(SignRefusedError);
    expect(() =>
      assertSonderEventSignable({
        tier: 'L1+L2+L3',
        verdict: 'pass',
        evidence: [],
      }),
    ).toThrow(SignRefusedError);
  });

  it('allows signing when L0+L1 ran AND evidence is present', () => {
    const g: SonderGovernanceBlock = {
      tier: 'L0+L1',
      verdict: 'pass',
      evidence: passingEvidence,
      policySet: 'p',
      policySetVersion: '1',
    };
    expect(() => assertSonderEventSignable(g)).not.toThrow();
  });

  it('allows signing when L0 alone ran (L0 fail case)', () => {
    // R8 example: L0 fail → tier = 'L0'. No L1/L2/L3 mentioned, so the
    // sign-refusal rule does NOT fire even though the event represents
    // a rejection. The verdict + evidence carry the story.
    const g: SonderGovernanceBlock = {
      tier: 'L0',
      verdict: 'fail',
      evidence: failingEvidence,
      reason: 'policy-deny:p@1:r',
    };
    expect(() => assertSonderEventSignable(g)).not.toThrow();
  });

  it('refuses to sign even when evidence array is missing (undefined)', () => {
    // The TS interface declares `evidence: PolicyEvidenceRow[]` but a
    // hand-rolled adapter could omit it. The runtime check guards
    // against this — undefined is treated as empty.
    const g = {
      tier: 'L1+L2',
      verdict: 'pass' as const,
    } as unknown as SonderGovernanceBlock;
    expect(() => assertSonderEventSignable(g)).toThrow(SignRefusedError);
  });

  it('does not refuse when the configured tiers ran with no policy bound but evidence is absent — wait, it MUST refuse', () => {
    // Documenting the R7 invariant: any L1/L2/L3 run without L0
    // evidence is a sign-refusal. The whole point is that L0 *must*
    // have run for the audit trail to be trustworthy.
    expect(() =>
      assertSonderEventSignable({
        tier: 'L2',
        verdict: 'pass',
        evidence: [],
      }),
    ).toThrow(/l0-evidence-missing/);
  });

  it('SignRefusedError exposes a typed code field', () => {
    try {
      assertSonderEventSignable({ tier: 'L1', verdict: 'pass', evidence: [] });
    } catch (err) {
      const sre = err as SignRefusedError;
      expect(sre.code).toBe('l0-evidence-missing');
      expect(sre.message).toMatch(/l0-evidence-missing/);
    }
  });
});

describe('end-to-end: L0 deny -> governance block -> sign decision', () => {
  it('an L0-denied contract produces a sign-allowed governance block', () => {
    // L0 fail → tier = 'L0' (no L1/L2/L3), evidence is populated.
    // The signer should accept the envelope: the deny is itself a
    // signed event in the audit trail.
    const contract = baseContract({
      l0: {
        ruleSetId: 'p',
        ruleSetVersion: '1',
        evidence: failingEvidence,
        durationMs: 0.4,
      },
    });
    const validation: TieredValidationResult = {
      passed: false,
      tier: 'L0',
      durationMs: 1,
      tiersRun: ['L0'],
      reason: 'policy-deny:p@1:tool-in-allowlist',
    };
    const g = buildGovernanceBlock(contract, validation);
    expect(() => assertSonderEventSignable(g)).not.toThrow();
    expect(g.verdict).toBe('fail');
    expect(g.evidence[0].outcome).toBe('fail');
  });

  it('an L1-pass with no policy bound triggers sign refusal', () => {
    // No policy → no L0 evidence → governance.evidence is []. If the
    // event nonetheless lists L1 in tier, the signer refuses. This
    // is the cryptographic backstop the spec calls out.
    const contract = baseContract();
    const validation: TieredValidationResult = {
      passed: true,
      tier: 'L1',
      durationMs: 5,
      tiersRun: ['L1'],
    };
    const g = buildGovernanceBlock(contract, validation);
    expect(g.evidence).toEqual([]);
    expect(() => assertSonderEventSignable(g)).toThrow(SignRefusedError);
  });

  it('a fully wired L0+L1+L2 pass is sign-allowed', () => {
    const contract = baseContract({
      l0: {
        ruleSetId: 'writing-pipeline',
        ruleSetVersion: '2026-05-11.1',
        evidence: passingEvidence,
        durationMs: 0.3,
      },
    });
    const validation: TieredValidationResult = {
      passed: true,
      tier: 'L2',
      durationMs: 12,
      tiersRun: ['L0', 'L1', 'L2'],
      confidence: 0.92,
    };
    const g = buildGovernanceBlock(contract, validation);
    expect(g.tier).toBe('L0+L1+L2');
    expect(() => assertSonderEventSignable(g)).not.toThrow();
  });
});

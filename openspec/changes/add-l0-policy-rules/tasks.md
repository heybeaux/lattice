# Tasks: L0 Policy-Rules Tier

Order is sequential. Each task is sized for one focused session.

## 1. Types and scaffolding

- [ ] Extend `ValidationTier` in `packages/core/src/breaker/types.ts` to include `'L0'`.
- [ ] Add `PolicyRuleKind`, `PolicyRuleBase`, `PolicyRule`, `PolicyRuleSet`, `PolicyEvidenceRow` types to `breaker/types.ts`.
- [ ] Add `policy?: PolicyRuleSet` to `TieredCircuitBreakerConfig`.
- [ ] Add `l0?: { ruleSetId: string; ruleSetVersion: string; evidence: PolicyEvidenceRow[]; durationMs: number }` to `StateContract.metadata`.

## 2. JSONPath subset evaluator

- [ ] Implement `packages/core/src/breaker/jsonpath.ts`: subset evaluator supporting `$`, `.name`, `['name']`, `[idx]`, `[*]`.
- [ ] Pre-parse JSONPath at `PolicyRuleSet` construction; cache compiled accessors per rule.
- [ ] Tests: 30+ cases covering happy path, missing paths, array wildcards, escaped keys.

## 3. L0 engine

- [ ] Implement `packages/core/src/breaker/policy.ts` with `evaluatePolicy(contract, ruleSet) -> PolicyEvidenceRow[]`.
- [ ] Cover all 7 rule kinds (`allowlist`, `denylist`, `regex-deny`, `numeric-bound`, `required`, `forbidden`, `custom`).
- [ ] Defensive default: unresolved JSONPath produces `outcome='fail'` with `detail='jsonpath did not resolve'` for everything except `forbidden` (passes) and `required` (fails with explicit reason).

## 4. Custom-rule fuzz harness

- [ ] Implement `packages/core/test/policy-fuzz.ts`: generate 100 random `StateContract` shapes; run each `'custom'` rule twice; assert agreement.
- [ ] Add a contributors' README note: custom rules MUST be pure and sync.

## 5. Wire L0 into the breaker

- [ ] Modify `packages/core/src/breaker/tiered.ts` to run L0 first when `config.policy` is set.
- [ ] On L0 fail: skip L1/L2/L3; set `contract.metadata.validationStatus = 'rejected'`; reject-reason format `policy-deny:<ruleSetId>@<version>:<ruleId>`.
- [ ] Skipped tiers do NOT appear in `governance.tier`. Tier string lists only tiers that actually ran.
- [ ] Emit OTel span attribute `lattice.l0.outcome` with `pass` | `fail`.

## 6. Adapter changes

- [ ] Update `packages/adapter-parliament/src/index.ts` to surface `contract.metadata.l0.evidence` on the SonderEvent's `governance.evidence`.
- [ ] Update `governance.policySet` and `governance.policySetVersion` from the L0 ruleSet.
- [ ] Update Parliament adapter test fixture with an allowlist rule + assertion that a non-allowlisted tool blocks at L0.

## 7. Sonder sign-refusal

- [ ] In the Sonder runtime (separate repo — coordinate change), add the sign-refusal check: if `governance.tier ∈ {L1,L2,L3}` and `governance.evidence` is empty/absent, throw `SignRefusedError('l0-evidence-missing')` before ed25519 sign.
- [ ] Add a regression test in Lattice's Parliament adapter that constructs an event missing L0 evidence and confirms sign refusal.

## 8. Tests

- [ ] 100% line coverage of `policy.ts` and `jsonpath.ts`.
- [ ] Integration test through `wrapAgent` confirming evidence lands on the contract.
- [ ] End-to-end Parliament adapter test: a deliberation with a `tool_in_allowlist` rule rejects an out-of-allowlist tool at L0 and writes the expected evidence row.
- [ ] Snapshot test of the rendered SonderEvent `governance` block with mixed pass/fail evidence rows.

## 9. Docs and release

- [ ] Update `packages/core/README.md` with L0 section.
- [ ] Update `PARLIAMENT_INTEGRATION.md` with the new `governance.evidence` shape.
- [ ] Update `THESIS.md` paragraph on tier ordering.
- [ ] Bump `@heybeaux/lattice-core` to v0.4.0. Bump `adapter-parliament` to v0.4.0.
- [ ] CHANGELOG entry citing this proposal.
- [ ] Add a `docs/policies/example-writing-pipeline-v1.yaml` reference rule set used by Spec 3.

## 10. Verify against the moat claim

- [ ] Write a one-page note (`docs/l0-moat-note.md`) asserting: any signed SonderEvent with `governance.tier ∈ {L1,L2,L3}` is provably preceded by an auditable L0 evidence row. Cite the sign-refusal test as the load-bearing assertion.
- [ ] Cross-reference the ops report (`heybeaux/ops:reports/ginnung-direction-2026-05-11.md`).

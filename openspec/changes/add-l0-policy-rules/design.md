# Design: L0 Policy-Rules Tier

## Where this lives

- `packages/core/src/breaker/types.ts` — extends `ValidationTier` to include `'L0'`; adds `PolicyRuleSet`, `PolicyRule`, `PolicyEvidenceRow`, `PolicyRuleKind` types.
- `packages/core/src/breaker/policy.ts` (new) — the L0 engine. Pure functions, no I/O, no async (rule evaluation is synchronous).
- `packages/core/src/breaker/tiered.ts` — wires L0 into the breaker as the first step before L1.
- `packages/core/src/contract/types.ts` — `StateContract.metadata.l0` slot.
- `packages/core/test/policy.test.ts` (new) — rule-kind coverage + fuzz harness.
- `packages/adapter-parliament/src/index.ts` — surfaces L0 evidence on the SonderEvent's `governance` block.

## Data model

```ts
export type PolicyRuleKind =
  | 'allowlist'
  | 'denylist'
  | 'regex-deny'
  | 'numeric-bound'
  | 'required'
  | 'forbidden'
  | 'conditional'
  | 'custom';

export type ConditionalPredicate =
  | { jsonpath: string; predicate: 'resolves' }
  | { jsonpath: string; predicate: 'is-truthy' }
  | { jsonpath: string; predicate: 'matches'; value: string };

export interface PolicyRuleBase {
  /** Stable identifier across versions. Used for evidence rows and audit. */
  id: string;
  /** Human-readable, one-line. Surfaces in reject reasons. */
  description: string;
  /** JSONPath into the StateContract being evaluated. Must start with `$`. */
  jsonpath: string;
}

export type PolicyRule =
  | (PolicyRuleBase & { kind: 'allowlist'; values: readonly string[] })
  | (PolicyRuleBase & { kind: 'denylist'; values: readonly string[] })
  | (PolicyRuleBase & { kind: 'regex-deny'; pattern: string; flags?: string })
  | (PolicyRuleBase & {
      kind: 'numeric-bound';
      op: '<=' | '<' | '>=' | '>' | '==';
      value: number;
    })
  | (PolicyRuleBase & { kind: 'required' })
  | (PolicyRuleBase & { kind: 'forbidden' })
  | (PolicyRuleBase & {
      kind: 'conditional';
      /** Antecedent. When this predicate is satisfied, `then` MUST be satisfied. */
      when: ConditionalPredicate;
      /** Consequent. Required only when `when` is satisfied. */
      then: ConditionalPredicate;
      /** PolicyRuleBase.jsonpath for conditional rules MUST equal when.jsonpath
       *  (so evidence rows surface the path that triggered evaluation). */
    })
  | (PolicyRuleBase & {
      kind: 'custom';
      /** Pure, deterministic, sync. Receives the canonicalized contract.
       *  Prefer `conditional` for cross-field invariants. */
      evaluate: (contract: StateContract) => boolean;
    });

export interface PolicyRuleSet {
  /** Stable identifier; appears on every evidence row. */
  id: string;
  /** Opaque version string. Bumped by hand on rule changes. */
  version: string;
  rules: readonly PolicyRule[];
}

export interface PolicyEvidenceRow {
  ruleId: string;
  kind: PolicyRuleKind;
  outcome: 'pass' | 'fail' | 'skip';
  jsonpath: string;
  /** Present when outcome = 'fail'. One sentence, no payload values. */
  detail?: string;
}
```

### Why pure + sync

L0 must produce identical evidence rows for identical inputs every time. Async or I/O-bearing rules invite non-determinism that defeats the audit story. Custom rules that *want* to be async should be promoted to L2/L3 instead.

### Why JSONPath (not raw property paths)

JSONPath has a wide-enough subset to cover real policy expressions (`$.outputs.payload.tool`, `$.outputs.payload.recipients[*]`) and is widely audited. We use a small built-in evaluator (subset of [RFC 9535](https://datatracker.ietf.org/doc/rfc9535/)) — no third-party dep. Anything more complex collapses to a `'custom'` rule.

## Ordering inside the breaker

Current flow (today): `L1 → maybe L2 → maybe L3`.

New flow: `L0 → L1 → maybe L2 → maybe L3`.

Semantics:

- **L0 hard-no**: if any rule outcomes `'fail'`, the breaker rejects immediately. L1/L2/L3 are not run; evidence rows for the unrun tiers are written with `outcome = 'skip'`.
- **L0 pass**: all rules outcomed `'pass'`. Proceed to L1 as today.
- **L0 not configured** (`policy === undefined`): evidence array is empty, breaker behaves exactly as v0.3.

The reject reason format becomes: `policy-deny:<ruleSet.id>@<version>:<rule.id>`. Example: `policy-deny:writing-pipeline-v1:tool_in_allowlist`. This is human-grep-friendly *and* machine-stable.

## Evidence row placement

Evidence rows live at `contract.metadata.l0` as:

```ts
contract.metadata.l0 = {
  ruleSetId: string;
  ruleSetVersion: string;
  evidence: PolicyEvidenceRow[];
  /** Wall time of L0 evaluation. */
  durationMs: number;
};
```

The breaker exposes a `summarize(contract)` helper so the adapters don't need to inline the slot path.

## Sonder/Parliament wiring

`adapter-parliament` already builds a SonderEvent envelope. The `governance` block today looks like:

```
"governance": { "tier": "L2", "verdict": "pass", "policy": "pii-v3" }
```

Post-L0 it becomes:

```
"governance": {
  "tier": "L0+L1+L2",
  "verdict": "pass",
  "policySet": "writing-pipeline-v1",
  "policySetVersion": "2026-05-11.1",
  "evidence": [
    { "ruleId": "tool_in_allowlist", "kind": "allowlist", "outcome": "pass", "jsonpath": "$.outputs.payload.tool" },
    { "ruleId": "no_pii_in_outputs", "kind": "regex-deny", "outcome": "pass", "jsonpath": "$.outputs.payload.body" },
    ...
  ]
}
```

`tier` becomes a `'+'`-joined list of tiers that **actually ran** (not what was configured). Skipped tiers (e.g. after an L0 fail) do not appear in `tier`.

**Sign-refusal rule**: the Sonder adapter refuses to ed25519-sign a SonderEvent whose `governance.tier` includes any of `L1`, `L2`, `L3` but whose `governance.evidence` is empty or absent. Enforces the "L0 must have run" invariant at the cryptographic boundary.

## How JSONPath is evaluated

- Subset implemented: `$`, `.name`, `['name']`, `[idx]`, `[*]` (wildcard), nested.
- No filters (`?(...)`), no recursive descent (`..`), no script expressions. If you need them, write a `'custom'` rule. This keeps the engine auditable.
- Path that doesn't resolve → `'required'` rule fails; `'forbidden'` rule passes; other rules fail with `detail = 'jsonpath did not resolve'`. Defensive default: if we cannot evaluate, the rule is treated as failed.

## Custom rule determinism enforcement

The fuzz harness runs each registered `'custom'` rule against 100 randomly-generated `StateContract` shapes twice (same input) and asserts the two evaluations agree. Disagreement → test fail with the offending input as a fixture. This catches `Date.now()`, `Math.random()`, and external lookups in custom rules.

## Performance

L0 is sync, in-process, JSONPath subset over JSON-shape data — overhead per rule is O(path-depth). Budget: **<1ms per rule on a typical contract**. Failure budget: a `PolicyRuleSet` with >100 rules should produce a warning during construction but not refuse — large rule sets are a smell, not an error.

## Migration

`@heybeaux/lattice-core` v0.3 → v0.4:

- `ValidationTier` adds `'L0'`. Existing `'L1' | 'L1+L2' | ...` values still work; they're now interpreted as "run L0 before whatever you asked for, *if* a `policy` was bound."
- `TieredCircuitBreakerConfig.policy?: PolicyRuleSet` is new and optional. Default behavior (no `policy`) is identical to v0.3.
- `contract.metadata.l0` is new. Consumers who serialize the contract should expect this slot.

No breaking API changes. Major version bump nevertheless because the audit story changes materially (`tier` field semantics).

## What this does NOT do

- Does not replace L1, L2, or L3.
- Does not introduce an async dependency at the L0 layer.
- Does not change the redaction pipeline (Spec 2 will).
- Does not introduce Merkle chaining of evidence rows (Spec 2 will, against the SonderEvent envelope).

## Open questions deferred to implementation

- Should `PolicyRuleSet` allow rule composition (group rules into named bundles)? Defer to v0.5.
- Should the breaker reject on construction when two rules share an `id`? Tentatively yes — fail loud.
- Should JSONPath be cached per-rule? Yes — pre-parse at `PolicyRuleSet` construction.

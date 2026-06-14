# Spec: Policy Rules (L0)

## Scope

This spec covers the L0 deterministic policy-rules tier of the Lattice Circuit Breaker: its data model, evaluation semantics, evidence format, and integration with the existing tiered breaker.

## Definitions

- **Rule** — one named, deterministic predicate evaluated against a StateContract.
- **RuleSet** — a versioned collection of rules with a stable ID.
- **Evidence row** — the per-rule result record produced by L0 evaluation.
- **Hard-no** — outcome where the contract is rejected and L1/L2/L3 are not run.

## Required behavior

### R1 — Tier ordering

The breaker MUST evaluate L0 before L1, L2, or L3 whenever `config.policy` is set. When `config.policy` is unset, L0 is a no-op and the existing v0.3 ordering (L1 → maybe L2 → maybe L3) applies.

### R2 — Hard-no on rule failure

If any rule in the bound `PolicyRuleSet` evaluates to `outcome = 'fail'`, the breaker MUST:

- Set `contract.metadata.validationStatus = 'rejected'`.
- Emit a reject reason matching `policy-deny:<ruleSetId>@<version>:<ruleId>`.
- Skip L1, L2, and L3.
- Record `outcome = 'skip'` evidence rows for the unrun tiers' tier names in any downstream tier summary (this is informational; the rejection is authoritative).

### R3 — Evidence row format

For every breaker invocation where `config.policy` is set, `contract.metadata.l0` MUST be populated with:

```ts
{
  ruleSetId: string;
  ruleSetVersion: string;
  evidence: PolicyEvidenceRow[];   // one row per rule in the set
  durationMs: number;              // wall time of L0 evaluation
}
```

Each `PolicyEvidenceRow` MUST contain:

- `ruleId` — the rule's stable identifier.
- `kind` — the rule kind.
- `outcome` — `'pass' | 'fail' | 'skip'`.
- `jsonpath` — the JSONPath the rule targeted.
- `detail` — required when `outcome = 'fail'`; one sentence; MUST NOT contain payload values.

When `config.policy` is unset, `contract.metadata.l0` MUST NOT be set.

### R4 — Rule kinds

L0 MUST support eight rule kinds with the semantics below.

- `allowlist`: value at JSONPath MUST equal one of `values`. Resolves to `fail` when path resolves but value is outside the set. Resolves to `fail` when path does not resolve.
- `denylist`: value at JSONPath MUST NOT equal any of `values`. Resolves to `pass` when path does not resolve.
- `regex-deny`: stringified value at JSONPath MUST NOT match the compiled regex. Resolves to `pass` when path does not resolve.
- `numeric-bound`: value at JSONPath, when numeric, MUST satisfy the comparison. Resolves to `fail` when path does not resolve or value is non-numeric.
- `required`: JSONPath MUST resolve to a non-null, defined value.
- `forbidden`: JSONPath MUST resolve to null or be absent.
- `conditional`: declarative if/then over two JSONPaths. Configuration:
  - `when` — `{ jsonpath: string, predicate: 'resolves' | 'is-truthy' | 'matches', value?: string }`. `resolves` = path resolves to non-null/non-undefined; `is-truthy` = resolves AND JS-truthy; `matches` = resolves AND string-equals `value`.
  - `then` — `{ jsonpath: string, predicate: 'resolves' | 'is-truthy' | 'matches', value?: string }`. Same predicate vocabulary.
  - Semantics: when `when` is satisfied, `then` MUST be satisfied (pass) else `fail`. When `when` is NOT satisfied, the rule resolves `pass` (vacuously). Failure detail string is `'when-satisfied-then-failed:<then.jsonpath>'`.
  - Designed for cross-field invariants like Spec 3's `intent_planned_before_action`: `when $.intent.action resolves, then $.intent.step_trace_id resolves`.
- `custom`: `evaluate(contract)` MUST return `true` (pass) or `false` (fail). Function MUST be pure and synchronous. Reserved for predicates that cannot be expressed with the other seven kinds; prefer `conditional` when possible. See R9 for the CI-only determinism gate.

### R5 — Determinism

L0 evaluation MUST be deterministic. Identical inputs MUST produce identical evidence rows including `detail` strings (but excluding `durationMs`). Custom rules that fail the fuzz determinism harness MUST be rejected at `PolicyRuleSet` construction time.

### R6 — JSONPath subset

L0 MUST implement the JSONPath subset defined in `design.md`: `$`, `.name`, `['name']`, `[idx]`, `[*]`. L0 MUST reject `PolicyRuleSet` construction when any rule's `jsonpath` uses features outside the subset (filter expressions, recursive descent, scripts).

### R7 — Sonder signing invariant

The Sonder runtime MUST refuse to ed25519-sign any SonderEvent whose `governance.tier` includes `'L1'`, `'L2'`, or `'L3'` and whose `governance.evidence` is empty or absent. The refusal MUST surface as `SignRefusedError('l0-evidence-missing')` before any signature is computed.

### R8 — Tier reporting

The `governance.tier` field in the emitted SonderEvent MUST list only the tiers that actually ran, joined with `+`. Tiers skipped due to an L0 fail MUST NOT appear. Example: an L0 fail produces `governance.tier = 'L0'`; an L0+L1 pass with L2 not configured produces `governance.tier = 'L0+L1'`.

### R9 — Construction validation

`PolicyRuleSet` construction MUST validate (synchronously, fast — runtime-path only):

- All rule IDs are unique within the set.
- All JSONPaths parse against the supported subset.
- All regex patterns compile.
- All `numeric-bound` ops are one of `<= < >= > ==`.
- Each `custom` rule's `evaluate` is a function (typeof check only).

Failures MUST throw at construction time, not at evaluation time.

**Determinism fuzz is CI-only.** Custom rules MUST pass a 100-iteration determinism fuzz check exposed via `verifyCustomRuleDeterminism(rule, fixtures)` from `@heybeaux/lattice-core/test-helpers`. Projects that ship custom rules MUST run this in their CI as a release gate. Running the fuzz at every `PolicyRuleSet` construction would violate R10's per-rule perf budget and is explicitly out of scope.

### R10 — Performance budget

L0 evaluation SHOULD complete in under 1ms per rule on a typical-sized StateContract (≤4KB payload). `PolicyRuleSet` construction with more than 100 rules SHOULD emit a console warning. Construction itself MUST complete in under 50ms for a 100-rule set.

### R11 — `redactJson` export

This change MUST export a top-level `redactJson(tree, { sensitivityLevel, mustNotRedact })` primitive from `@heybeaux/lattice-core`. It MUST be the same primitive that backs the existing `redactContract`. The signature is:

```ts
export function redactJson(
  tree: unknown,
  opts: {
    sensitivityLevel: 'low' | 'medium' | 'high';
    mustNotRedact?: readonly string[];   // JSONPaths to refuse redacting
  }
): {
  redacted: unknown;
  fields: string[];                       // JSONPaths of redacted fields
  refusalPath?: string;                   // first mustNotRedact violation, if any
};
```

Sonder (Spec 2) consumes this directly. `redactContract` is refactored to wrap `redactJson`; its public signature does not change.

## Non-goals

- L0 does NOT replace, merge with, or shadow L1.
- L0 does NOT execute async or I/O-bearing predicates. Such cases belong in L2/L3.
- L0 does NOT introduce a compiled rule language (Rego/CEL). The JSON-shape `PolicyRuleSet` is the contract.
- L0 does NOT chain or version rules across runs. Versioning is opaque-string at the `PolicyRuleSet` level only.

## Out-of-band notes

- The reference YAML rule set used by the writing-pipeline dogfood loop (Spec 3) lives at `docs/policies/example-writing-pipeline-v1.yaml`.
- The Sonder sign-refusal change crosses repo boundaries; coordinate the merge of this Lattice change with the corresponding Sonder change. CI in Sonder MUST pin `@heybeaux/lattice-core@^0.4.0` before merging.

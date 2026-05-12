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

L0 MUST support seven rule kinds with the semantics below.

- `allowlist`: value at JSONPath MUST equal one of `values`. Resolves to `fail` when path resolves but value is outside the set. Resolves to `fail` when path does not resolve.
- `denylist`: value at JSONPath MUST NOT equal any of `values`. Resolves to `pass` when path does not resolve.
- `regex-deny`: stringified value at JSONPath MUST NOT match the compiled regex. Resolves to `pass` when path does not resolve.
- `numeric-bound`: value at JSONPath, when numeric, MUST satisfy the comparison. Resolves to `fail` when path does not resolve or value is non-numeric.
- `required`: JSONPath MUST resolve to a non-null, defined value.
- `forbidden`: JSONPath MUST resolve to null or be absent.
- `custom`: `evaluate(contract)` MUST return `true` (pass) or `false` (fail). Function MUST be pure and synchronous.

### R5 — Determinism

L0 evaluation MUST be deterministic. Identical inputs MUST produce identical evidence rows including `detail` strings (but excluding `durationMs`). Custom rules that fail the fuzz determinism harness MUST be rejected at `PolicyRuleSet` construction time.

### R6 — JSONPath subset

L0 MUST implement the JSONPath subset defined in `design.md`: `$`, `.name`, `['name']`, `[idx]`, `[*]`. L0 MUST reject `PolicyRuleSet` construction when any rule's `jsonpath` uses features outside the subset (filter expressions, recursive descent, scripts).

### R7 — Sonder signing invariant

The Sonder runtime MUST refuse to ed25519-sign any SonderEvent whose `governance.tier` includes `'L1'`, `'L2'`, or `'L3'` and whose `governance.evidence` is empty or absent. The refusal MUST surface as `SignRefusedError('l0-evidence-missing')` before any signature is computed.

### R8 — Tier reporting

The `governance.tier` field in the emitted SonderEvent MUST list only the tiers that actually ran, joined with `+`. Tiers skipped due to an L0 fail MUST NOT appear. Example: an L0 fail produces `governance.tier = 'L0'`; an L0+L1 pass with L2 not configured produces `governance.tier = 'L0+L1'`.

### R9 — Construction validation

`PolicyRuleSet` construction MUST validate:

- All rule IDs are unique within the set.
- All JSONPaths parse against the supported subset.
- All regex patterns compile.
- All `numeric-bound` ops are one of `<= < >= > ==`.
- Custom rules pass a 100-iteration determinism fuzz check.

Failures MUST throw at construction time, not at evaluation time.

### R10 — Performance budget

L0 evaluation SHOULD complete in under 1ms per rule on a typical-sized StateContract (≤4KB payload). `PolicyRuleSet` construction with more than 100 rules SHOULD emit a console warning.

## Non-goals

- L0 does NOT replace, merge with, or shadow L1.
- L0 does NOT execute async or I/O-bearing predicates. Such cases belong in L2/L3.
- L0 does NOT introduce a compiled rule language (Rego/CEL). The JSON-shape `PolicyRuleSet` is the contract.
- L0 does NOT chain or version rules across runs. Versioning is opaque-string at the `PolicyRuleSet` level only.

## Out-of-band notes

- The reference YAML rule set used by the writing-pipeline dogfood loop (Spec 3) lives at `docs/policies/example-writing-pipeline-v1.yaml`.
- The Sonder sign-refusal change crosses repo boundaries; coordinate the merge of this Lattice change with the corresponding Sonder change. CI in Sonder MUST pin `@heybeaux/lattice-core@^0.4.0` before merging.

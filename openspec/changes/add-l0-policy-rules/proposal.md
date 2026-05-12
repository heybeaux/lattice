# Proposal: Lattice L0 — Deterministic Policy-Rules Tier

## Intent

The 2026-05-11 Parliament direction-setting run (8-model cooperative, see `heybeaux/ops:reports/ginnung-direction-2026-05-11.md`) identified Lattice's governance story as the weakest assumption underpinning Ginnung's moat. Both the prior 5-model assessment panel and the 8-model team converged independently on the same problem:

> L2 (embedding similarity) and L3 (LLM-as-judge) both reduce to "a model judging a model." A sophisticated customer or regulator will ask: **who judges the judge?** Without a deterministic floor with auditable evidence *before* probabilistic tiers fire, governance is performative.

L1 today is a deterministic *structural* tier — it validates the State Contract against a JSON Schema. That answers "is this payload well-formed?" but does not answer "**is this action permitted by named policy?**" The two questions are different. A perfectly structured contract can still violate a policy ("tool was not on the allowlist", "output contained un-redacted PII", "budget exceeded the cap").

This proposal adds **L0: a deterministic policy-rules tier** that runs **before L1** and produces a per-rule evidence row. L0 is the load-bearing fix for the moat claim: any SonderEvent stamped `governance.tier ∈ {L1, L2, L3}` must show a passing L0 evidence row in its audit trail, or the runtime refuses to sign.

## Scope

### In scope

- **`ValidationTier`** extended to `'L0' | 'L1' | 'L2' | 'L3'`. L0 is **always mandatory** when the breaker is enabled — there is no way to disable it once a `PolicyRuleSet` is bound to the breaker.
- **`PolicyRuleSet`** — a typed collection of named rules. Each rule is one of:
  - `'allowlist'` — value at JSONPath must be in a finite set
  - `'denylist'` — value at JSONPath must not be in a finite set
  - `'regex-deny'` — value at JSONPath must not match a regex (PII patterns, secrets, etc.)
  - `'numeric-bound'` — value at JSONPath must satisfy a comparison (`<=`, `<`, `>=`, `>`, `==`)
  - `'required'` — JSONPath must resolve to a non-null value
  - `'forbidden'` — JSONPath must resolve to null/absent
  - `'custom'` — host-provided pure function `(contract) => boolean`. Function must be deterministic and side-effect-free; runtime asserts both via fuzz harness in tests.
- **Evidence row schema** — each rule evaluation produces a record:
  ```ts
  { ruleId: string; kind: PolicyRuleKind; outcome: 'pass' | 'fail' | 'skip'; jsonpath: string; detail?: string }
  ```
  Stored on the StateContract under `metadata.l0.evidence: PolicyEvidenceRow[]`. Always present when L0 ran. Empty array only when no rules were bound.
- **L0 ordering** in the breaker: L0 runs first. If any rule fails, the contract is rejected immediately and L1/L2/L3 are skipped (with `evidence.outcome = 'skip'` rows for the unrun tiers). The reject reason names the failed rule ID.
- **Wiring**: `TieredCircuitBreakerConfig.policy?: PolicyRuleSet` is the new field. When omitted, L0 is a no-op (zero rules, evidence array empty). When present, L0 is mandatory.
- **Sonder integration**: SonderEvent's `governance.evidence` is populated from `contract.metadata.l0.evidence`. The runtime refuses to ed25519-sign an event whose `governance.tier` claims L1+ when no L0 evidence row exists.
- **Tests**: 100% line coverage of rule kinds. Fuzz harness for `'custom'` rules. Integration test through `wrapAgent`. Parliament adapter end-to-end test that confirms a forbidden tool blocks at L0.

### Out of scope (deferred)

- **L0 rule federation** — sharing rule sets across agents/teams. v0.4 candidate.
- **L0 rule versioning** — `policy-v3` style identifiers with migration support. v0.4 candidate. For v0.3, the `PolicyRuleSet` carries an opaque `id` and `version` string but no migration semantics.
- **Compiled rule engine** (Rego/CEL/OPA) — out of scope. The deterministic JSON predicates are intentionally simple to keep the audit story tight. We will revisit if a customer demands OPA compatibility.
- **L0 + L1 merging** — they stay separate. L1 is for schema, L0 is for policy. Merging would re-introduce the ambiguity the spec exists to remove.

## Why this is load-bearing

Two consequences flow from L0:

1. **The moat changes shape.** The 8-model synthesis (paraphrased): *the moat is not the schema — it is the runtime invariant that cognitive precursors are co-emitted before action, plus the accumulating corpus of public SonderEvent logs.* L0 is what makes the invariant **enforceable**. Without L0, the invariant is "the runtime tries its best." With L0, the invariant is "every signed event carries a deterministic, named, auditable policy pass before any probabilistic judgment ran."
2. **The EU AI Act story tightens.** Article 14 (oversight) and Article 15 (robustness) are easier to defend when "we governed this action with rule `policy.tool_in_allowlist@v3`" is the answer, not "the LLM judge confidence was 0.81."

## Risks and counterpositions

- **Risk: rule rot.** Policy rules drift from intent over time. Mitigation: rules are first-class versioned records in ops repo (`ops/policies/<id>.yaml`); changes go through PR review. Stress-test cadence (Spec 3) exercises rules weekly.
- **Risk: false-negatives — a rule passes but the action is wrong.** This is L2/L3's job, which is why we kept them. L0 sets the floor, not the ceiling.
- **Counter: "L1 already does this."** It does not. L1 validates schema shape; L0 validates policy. A contract can have a well-formed `outputs.payload.email = 'a@b.com'` (L1 passes) and still violate `no_pii_in_outputs` (L0 fails). This distinction is the whole point.
- **Counter: "Just use OPA."** OPA is a fine compiled rule engine but the audit-row format and the SonderEvent integration are bespoke. We could compile a `PolicyRuleSet` to Rego later; we cannot start from Rego and back out the SonderEvent integration.

## Acceptance criteria

1. `ValidationTier` includes `'L0'`. `TieredCircuitBreakerConfig.policy` accepts a `PolicyRuleSet`.
2. L0 runs before L1. Failures short-circuit the breaker.
3. Every breaker invocation with a bound `PolicyRuleSet` produces `contract.metadata.l0.evidence` with one row per rule.
4. The Parliament adapter rejects a contract whose `action.tool` is not in a configured allowlist at L0, with the reject-reason naming the rule ID.
5. The Sonder adapter refuses to sign a SonderEvent claiming `governance.tier ∈ {L1, L2, L3}` when no L0 evidence row exists.
6. Tests: rule-kind coverage at 100% lines; fuzz harness for custom rules; end-to-end test through Parliament.
7. CHANGELOG updates `@heybeaux/lattice-core` to v0.4.0.

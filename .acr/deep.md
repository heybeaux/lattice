# Lattice — Deep

Loaded when designing in or debugging Lattice. Token budget ~2500.

## Role in the fencing architecture

Three-layer split locked 2026-05-14:
- **Sonder** — mechanism. `checkGate()` adapter hook + `GatePendingError` + emit-pipeline veto between `buildEnvelope` and `redact`.
- **Lattice (and AWM)** — policy. `getGateStatus(event)` callbacks decide *when* to gate. Lattice typically reads from `StateContract.approval_gate`; AWM reads from step intent.
- **Ginnung** — surface. Renders pending gates, calls `gateRegistry.resolve(id, action)` to clear them.

Lattice's adapter config registers its `getGateStatus` with Sonder's runtime. When Sonder's emit pipeline reaches step 1.5, every registered adapter's `checkGate` runs; Lattice's returns pending if the event matches an approval_gate predicate.

## State contracts

Schema-level contracts between agents about state. Conceptually similar to row-level constraints but applied to inter-agent handoffs. The `approval_gate` predicate is a property of a state contract — "this transition requires approval before emission."

## Key decisions / recent incidents

- **2026-05-12** — pnpm 10 / mise / corepack incident. PR #37 coder subagent ran pnpm install with corepack-shimmed pnpm 8.15.6 → lockfile downgrade → all 3 CI matrix jobs failed at install. Workaround: standalone pnpm 10 binary at a fresh path.
- **2026-05-14** — fencing architecture locked. Lattice's role as policy-owner (not mechanism-owner) cemented.

## Internal vocabulary

- **State contract** = a declared shape and constraint set on inter-agent state
- **approval_gate** = a property of a state contract triggering Lattice's gate
- **getGateStatus** = the callback adapter contract Lattice implements
- **Three-layer split** = Sonder mechanism / Lattice+AWM policy / Ginnung surface

## Boundaries

- Lattice **does** define gate policy, write state contracts, partner with AWM on intent-driven gating.
- Lattice **does not** veto emissions itself (Sonder does), render gate UIs (Ginnung does), or sign events (Sonder does).
- Lattice **is** consumed in-process by Ginnung in v1 (Option C).

## Open questions / parked work

- **State-contract schema versioning.** Need migration story for contract evolution.
- **Substep-level policies.** v1 is turn-level gating only; v1.5 adds substeps. Lattice's policy shape needs to extend.

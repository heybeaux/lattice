# Aegis Phase 3.5 — Sonder core change scope

> 2026-06-14 · Implementation scope for the labeling substrate · grounded in a read-only source audit
> of `/Users/beauxwalton/sonder`. Companion to `aegis-action-failed-label-spec` §1.5.
> Sonder is **ours**, so these are normal upstream changes, not constraints.

Phase 3.5 gates Phase 4 (AWM) only. Phases 0–3 have zero Sonder deps. Four changes, ordered by
dependency. All paths relative to `/Users/beauxwalton/sonder`.

**Audit correction:** the emit pipeline + runtime live in `packages/sdk/` (not core). `withSonder`
already emits before/after/error events with `parent_id` linkage — so the outcome-event hook has a
natural home.

---

## Change 1 — Typed post-execution OUTCOME event · effort: M

The crux: today the gate is pre-emit only; nothing records tool result (exit/isError/error). Without
this, `tool_error` + `downstream_error` labels have no source.

- **No event-kind enum exists.** Events discriminate only on `version` ('1'|'2'); `payload` is
  freeform `unknown` (`packages/core/src/types/event.ts:127`). Soft convention: `payload.phase`
  (`'before'|'after'|'error'`) set ad-hoc in `packages/sdk/src/with-sonder.ts:54,67,79`.
- **Add** a typed `OutcomePayload { phase: 'outcome'; exit_code?: number; isError: boolean; error?: string }`
  near the context types in `event.ts` (~L99, after `IntentContext`).
- **Entry point:** `runtime.emit` (`packages/sdk/src/runtime.ts:36-46,93`) → `EmitPipeline.emit`
  (`emit-pipeline.ts:60-69`). Add an `emitOutcome(decisionEventId, result)` helper that wraps
  `emit({ parent_id: decisionEventId, payload: outcome })`. Natural home: extend `withSonder`
  (`with-sonder.ts:74-80`) — it already emits the "after" event with `parent_id: beforeEvent.id`.
- **Ripple:** bus typed-handler dispatch keys off `intent.action` (`bus.ts:128,150`); set it on
  outcome events if we want `on('outcome')` to fire.

## Change 2 — `parent_id` column + index + descendant query · effort: M

Needed to walk "decision event → all its consequences" for label assembly.

- **`parent_id` already on the envelope** (`event.ts:117`) and flows through `buildEnvelope` via the
  `...base` spread — but it is **not a SQLite column**, so no indexed traversal.
- **Migration is idempotent ALTER**, not a migrations folder: extend `migrateLegacySchema()`
  (`packages/core/src/.../audit.ts:72-88`) with a guarded `ALTER TABLE events ADD COLUMN parent_id TEXT`.
- **CREATE TABLE** `audit.ts:37-49`; **index block** `audit.ts:50-56` → add
  `CREATE INDEX IF NOT EXISTS idx_parent ON events(parent_id)`.
- **Insert** `write()` `audit.ts:96-122` → add `parent_id` to columns/VALUES/run-object
  (`event.parent_id ?? null`).
- **Descendant query:** new method by `query()` (`audit.ts:183-217`) using
  `WITH RECURSIVE` — seed `id = ?`, recurse `JOIN events ON events.parent_id = cte.id`.
- Note: `parent_id` is already recoverable from the JSON `payload` blob, but only a real column gives
  the indexed recursive join.

## Change 3 — typed `resources`/`paths` envelope field · effort: L (sleeper)

Needed for rollback detection (overlap of touched paths).

- **Add** optional `paths?: string[]` (or a `ResourceContext`) to `SonderEventCore`
  (`event.ts:113-129`) so it's signed/audited. **Make it optional** to preserve v1 back-compat reads.
- **Signing auto-covers it** — `sign.ts:143-148` → `hash.ts:88` canonicalizes the whole object via
  `Object.keys`, no fixed field list. Good.
- **BUT** `DEFAULTS` in `bus.ts:19-28` enumerates each context field explicitly — a new field must be
  added there or `buildEnvelope` produces malformed envelopes.
- **Redaction allowlist:** `DEFAULT_MUST_NOT_REDACT` (`redact.ts:255`, applied
  `emit-pipeline.ts:102`) — add `paths` if it must survive redaction.
- **Real cost:** new canonical byte layout → **golden-hash fixtures break**. `spec2-acceptance` /
  `verify-chain` / `hash` / `sign` tests need regen. No formal sign-format version field exists;
  `version` stays `'2'` — coordinate the verifier. Plan a fixture-regen step.

## Change 4 — Aegis hook populates `governance.approval_gate` + `evidence` · effort: S

So the decision event records the gate verdict (= the row's label anchor + a free feature).

- **Shapes confirmed:** `GovernanceContext` (`event.ts:60-83`); `approval_gate?: ApprovalGate`
  (`event.ts:51-58`: state/gate_id/reason/default_action/expires_at); `evidence?: PolicyEvidenceRow[]`
  (`event.ts:34-41`).
- **Use the adapter `contribute()` path**, not caller-supplied governance. Stock `LatticeAdapter.contribute`
  (`adapters/lattice/src/index.ts:67-88`) only fills validation booleans + omits `approval_gate`/`evidence`.
  An **Aegis adapter** implements `contribute` to return `{ governance: { ...approval_gate, evidence } }`.
- **Why not caller-supplied:** `buildEnvelope` merges `...DEFAULTS, ...base` then adapter diffs
  overwrite (`bus.ts:86-105`); a registered LatticeAdapter returning `EMPTY_GOVERNANCE`
  (`lattice:47-55,71`) would clobber caller governance. Adapter path is the safe one.
- **Vetoing is separate** from recording: `checkGate` (`adapter.ts:23`) → `findPendingGate`
  (`gate.ts:53-66`), wired via `getGateStatus` (`lattice:101-143`).

---

## Tests & conventions

- **Test dirs:** `packages/core/src/__tests__/` (audit, chain, hash, sign, redact, envelope.integration);
  `packages/sdk/src/__tests__/` (emit-pipeline, runtime, with-sonder, gate, verify-chain, spec2-acceptance).
- **Per change:** C1 → `with-sonder.test.ts` + `emit-pipeline.test.ts`; C2 → `audit.test.ts`
  (`baseCore` fixture L12-27, `v1()`/`v2()` builders); C3 → `sign`/`hash`/`spec2-acceptance` (golden
  hashes — regen); C4 → `gate.test.ts` + lattice adapter tests.
- **No CHANGELOG.** Convention is spec-reference comments ("Spec 2 R12") + prose in `docs/`. Schema
  migration = idempotent ALTER in `migrateLegacySchema()`. Follow that.

## Recommended implementation order
1. **C4** (S) — adapter populates governance; unblocks decision-event recording, no schema churn.
2. **C2** (M) — parent_id column/index/descendant query; the traversal backbone.
3. **C1** (M) — outcome event; the missing label source. Depends on C2 for linkage.
4. **C3** (L, last) — paths field; isolate the golden-hash fixture regen into its own PR so the
   sign-layout change is reviewed alone.

## Two sleeper risks (from audit)
- **C3:** signing auto-covers new fields, but `bus.ts` `DEFAULTS` enumeration + golden-hash fixtures
  will break — budget a fixture-regen pass, ship C3 as its own PR.
- **C4:** adapter-clobber ordering in `buildEnvelope` — caller-supplied governance gets overwritten by
  a registered adapter. Use the adapter path, don't pass governance into `emit`.

# Aegis Real Labeling Pipeline — Build Scope v1

> 2026-06-14 · Owner: @beauxwalton · Author: Rook
> Turns the **decided** label schema (`aegis-action-failed-label-spec-2026-06-14.md`) into a buildable
> pipeline now that the Sonder labeling substrate has landed (sonder `ac90d8c`). This is the bridge
> from the synthetic `aegis-bench` predictor stub to a real, walk-forward `action_failed` dataset.

---

## 0. What changed since the label spec

The label schema (v1) was written against a Sonder chain that **lacked** outcome events, `parent_id`
traversal, and structured resources — it flagged these RED/YELLOW and gated Phase 4 behind a new
"Phase 3.5 (Sonder labeling substrate)." **That substrate is now merged** (sonder `ac90d8c`):

| Prereq (was RED/YELLOW) | Now | Evidence (sonder) |
|---|---|---|
| `parent_id` column + index | 🟢 landed | `packages/core/src/audit.ts:91-92` |
| Descendant traversal query | 🟢 landed | `audit.ts:261 queryDescendants(rootId,{maxDepth})` |
| Post-execution outcome event | 🟢 landed | `event.ts:109-151 OutcomeContext{exit_code?,isError,error?}` |
| Structured `resources[]` touched | 🟢 landed | `event.ts:153-160 resources?: string[]` |
| Gate decision in `governance` | 🟡 our code | Aegis hook must populate `approval_gate`+`evidence` at emit |

**Net:** the four label signals (`human_veto`, `tool_error`, `downstream_error`, `rollback`) all now
have a real source in the chain. The only remaining YELLOW is *our* hook populating the gate decision,
which is in-scope below. **Phase 4 is unblocked.**

This doc scopes the code that consumes the substrate. It does **not** re-decide the schema, window
(§8.5 DECIDED: `min(next user turn, 10 min, EOS)`, 30 min for bash-critical/secrets), or feature row —
those are frozen in the label spec.

---

## 1. Where it lives & the artifact boundary

New package: **`@heybeaux/aegis-label`** in `~/Dev/lattice/packages/aegis-label`. Sibling to
`aegis` (rules) and `aegis-bench` (benchmark). Rationale:

- **Separable from the harness.** The deterministic harness (`aegis`) ships with zero label
  dependencies. Labeling is the *learning* loop bolted on; keeping it its own package preserves the
  "deterministic core ships first" property and keeps the OSS rules package lean.
- **Depends on:** `@heybeaux/lattice-aegis` (rule eval → feature inputs), Sonder core (read the chain
  via `AuditLog`), Engram client (as-of priors). Sonder is read-only here — we *consume* the chain,
  the Aegis hook *writes* the decision + outcome events.

What stays public vs local (label spec §9 privacy): **rules ship public; the labeling pipeline +
trained model ship local/per-deployment** (rows carry command strings/paths). `aegis-label` is
publishable as code, but a deployment's dataset/model is private.

---

## 2. Pipeline stages (the build)

```
Sonder chain (decision + outcome + veto + downstream events)
   │
   ├─[A] Decision-row minting   — one row per gate=allow / ask→approved decision event
   ├─[B] Window manager         — open/close windows per §3/§8.5; freeze on close
   ├─[C] Label resolver         — descendant scan → first-match signal (§2 priority table)
   ├─[D] Feature assembler      — feature row frozen at decision time (§5), Engram as-of priors
   └─[E] Dataset writer         — append frozen {features, action_failed, reason, confidence}
                                     ↓
                          nightly bake (AWM retarget) — separate, existing AWM machinery
```

Each stage maps to one module. Estimated build below.

### [A] Decision-row minting — `src/mint.ts`
- Input: a Sonder decision event (the Aegis PreToolUse emit). Mint a row **only** if gate resolved to
  `allow` or `ask→approved` (label spec §1). Denied/vetoed → deny channel (§4), not the classifier.
- Requires the Aegis hook to have populated `governance.approval_gate` (the one YELLOW). **Sub-task:
  wire the hook** to set `approval_gate` + `evidence[]` from `checkGate` output when it emits. This is
  the only Sonder-adjacent write we own.
- Output: a `PendingRow{decisionEventId, signalDate, features:partial}` in the open-window store.

### [B] Window manager — `src/window.ts`
- Opens a window at decision time; closes on the **first** of: next user-turn event, 10-min wall-clock
  (30 for bash-critical/secrets per `window.byCategory`), end-of-session, or an early-close signal
  (`tool_error`/`human_veto` chained to the decision).
- "Next user turn" + "end of session" come from Sonder session/turn events — **confirm these event
  kinds exist in the chain** (open item §5). Wall-clock is timestamp arithmetic.
- A row is **frozen** when its window closes. Only frozen rows are eligible for bake (walk-forward
  guarantee, label spec §3). Persist open windows so a restart doesn't lose pending rows.

### [C] Label resolver — `src/resolve.ts`
- On window close, run `auditLog.queryDescendants(decisionEventId, {maxDepth})` + a time-bounded scan,
  then apply the §2 priority table (first match wins):
  1. `human_veto` — veto/undo event with `parent_id` chaining to decision, or OpenClaw user-correction
  2. `tool_error` — outcome event `isError===true` or `exit_code!==0`
  3. `downstream_error` — `severity=error` event causally linked within window
  4. `rollback` — git revert/reset/restore or trash-restore on **overlapping `resources[]`**
  - else `action_failed = 0`. Abnormal session end inside window → `NULL` (excluded; Truth-above-all,
    never guess a label).
- Emit `labelReason` + `labelConfidence` (hard 1.0 for veto/tool_error, 0.6–0.8 for inferred; v1 ships
  hard 0/1 but records confidence for v2 sample-weighting).

### [D] Feature assembler — `src/features.ts`
- Build the §5 feature row **from events at/before the decision only**. Command-shape features come
  from the Aegis rule-eval output already attached to the decision event (tool, ruleSeverityMax,
  combinatorCount, pathsTouched, …) — no re-parsing.
- `sessionHealthRegime` (clean/recovering/thrashing, §6) from rolling in-session outcome counters.
- **Engram priors queried as-of `signalDate`, not "now"** (label spec §5 leak guard; same bug class as
  AWM's 2026-04-21 stale-cache fix). `histFailRate_toolPath`, `secsSinceLastFailHere`, `engramPriorN`.
- **Leak assertion:** extractor hard-fails if any feature timestamp > decisionEventId timestamp.

### [E] Dataset writer — `src/dataset.ts`
- Append frozen rows to the training store (one row = one example, label spec §7). Format: JSONL +
  a small SQLite index keyed on `(signalDate, severity)` for the bake's walk-forward folds.
- Idempotent on `decisionEventId` (re-running the resolver must not double-write).

---

## 3. What this does NOT include (explicit boundaries)

- **The bake / AWM retarget itself.** That reuses existing AWM machinery (walk-forward LR+XGBoost,
  calibration). `aegis-label` produces the dataset; the bake is a separate, already-built capability
  pointed at the new target. Scoping the bake wiring is a follow-up once we have ≥ the minimum dataset.
- **Going live in the gate.** AWM runs **shadow mode** (label spec §8) until the floor + ECE bar are
  met. This pipeline only produces labels + lets us *measure* calibration; flipping to live-escalation
  is gated separately.
- **Backfill of historical chains.** We start labeling forward from deploy. No real labeled history
  exists yet (Sonder outcome events are new), so the dataset grows from now. `aegis-bench` stays
  synthetic until the real dataset clears the shadow-mode floor — at which point bench gains a
  real-data column alongside the synthetic one.

---

## 4. Cold-start path (graceful degradation, no data)

Until ≥ floor labeled rows accrue, the gate uses the **rule-derived prior** from the label spec §7.1,
not a model: `P(failure) = baseRate[ruleSeverityMax]` (`critical 0.90 / high 0.45 / medium 0.20 /
low 0.03 / none 0.01`). This is what lets Aegis degrade to pure-deterministic-Lattice behavior with
zero data — and it's exactly the `awm-stub` column the benchmark already models, except the bench stub
is intentionally overfit to show the shape. The real cold-start is these honest priors.

---

## 5. Open items to confirm before/while building

1. **Session/turn event kinds.** Window-close on "next user turn" + "end of session" assumes Sonder
   emits these. **Confirm in the chain** — if absent, the window falls back to wall-clock + EOS only
   (still correct, just less adaptive). *Cheapest first check; do before [B].*
2. **`human_veto` source.** Does OpenClaw emit a user-correction/undo event into the Sonder chain, or
   only Sonder's own veto path? Determines resolver signal #1's reach.
3. **`downstream_error` causal reliability.** `queryDescendants` gives the structural DAG; confirm
   error events actually set `parent_id` to their cause (vs. only sibling-by-time). If parentage is
   unreliable for downstream errors, weight that signal lower (already 0.6–0.8) or defer to v2.
4. **Resource overlap matching for `rollback`.** Define "overlapping `resources[]`" — exact path,
   prefix, or normalized? Recommend normalized path-prefix overlap; spec it in `resolve.ts`.
5. **Shadow-mode floor numbers.** Min rows/severity + ECE bar — pick once we see real ingest rate
   (label spec §8 left this open by design).

---

## 6. Estimate & sequencing

| Stage | Module | Est | Depends on |
|---|---|---|---|
| Hook populates `approval_gate` | aegis hook | 0.5 d | substrate (done) |
| [A] mint | `mint.ts` | 0.5 d | hook |
| [B] window | `window.ts` | 1.5 d | open item #1 |
| [C] resolve | `resolve.ts` | 1.5 d | substrate `queryDescendants` (done) |
| [D] features | `features.ts` | 1.5 d | Engram as-of client |
| [E] dataset | `dataset.ts` | 0.5 d | — |
| Tests (port label-spec cases as fixtures) | `test/` | 1.0 d | all |
| **Total** | | **~7 person-days** | |

Then a separate ~1–2 d to wire the existing AWM bake at the new dataset, after the floor is hit.

**Build order:** confirm open item #1 → hook+mint → resolve (it's the highest-risk logic) → window →
features → dataset → tests. Resolve before window so we validate the signal-extraction against real
chain shapes early.

---

## 7. Definition of done (this scope)
- `aegis-label` produces frozen `{features, action_failed, labelReason, labelConfidence}` rows from a
  live Sonder chain, walk-forward clean (leak assertion passes).
- Cold-start priors active; shadow-mode wiring present (scores logged, gate ignores).
- Tests: the label-spec §2 priority table + §3 window + §5 leak guard covered with chain fixtures.
- Honesty: every dataset artifact records `dataSource` (real vs synthetic) and `schemaVersion`.

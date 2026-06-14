# Aegis `action_failed` Label Schema — Spec v1

> 2026-06-14 · Unblocks Build Plan Phase 4 (AWM predictive layer) · Companion to
> `autoharness-killer-build-plan-2026-06-14.md` and `aegis-rulepack-spec-2026-06-14.md`
> Defines the supervised target AWM is retargeted onto (`direction_5d` → `action_failed`), how it's
> derived **automatically** from the Sonder audit chain, the feature row, and the windowing/labeling
> discipline that keeps it leak-free.

---

## 0. Why this spec is the linchpin

AWM is a calibrated binary classifier. Reusing its machinery for governance needs exactly one new
thing: a clean, automatable boolean label per action. If the label is noisy or leaks the outcome
into the features, the predictor is worse than the rules it's meant to augment. Everything else
(features, calibration, walk-forward) AWM already does in prod. **So this doc is the make-or-break.**

Core constraint, inherited from AWM's discipline: **walk-forward, no lookahead.** The label for an
action must come strictly from events that happen *after* the gate decision. The features must come
strictly from events *at or before* it. The Sonder signed chain gives us a totally-ordered,
tamper-evident event log — perfect for this.

---

## 1. The unit: one gated action = one labeled row

Every PreToolUse evaluation (Aegis §5 output) emits a `SonderEvent` we call the **decision event**.
Its eventual fate produces the label. A row is:

```
row = features(decision_event, context_at_decision_time)  →  action_failed ∈ {0, 1}
```

Rows are only minted for actions that **were allowed to run** (gate `allow`, or `ask`→approved).
Denied/vetoed actions never execute, so they have no execution outcome — they are handled separately
(§4, "the deny channel") and excluded from the core failure classifier's training set to avoid
selection-bias circularity (we'd be training "things we blocked are bad" — useless).

---

## 1.5 Sonder-chain prerequisites (audit verdict 2026-06-14)

A source audit of `/Users/beauxwalton/sonder` (file:line verified) found the chain is **not yet
sufficient** to mint these labels. This section is binding: **Phase 4 cannot start until the RED
items below land.** They become a new Phase 3.5 ("Sonder labeling substrate").

| Need | Verdict | Evidence | Required change |
|---|---|---|---|
| Envelope core fields | 🟢 GREEN | `packages/core/src/types/event.ts:113-156`. Note: hash field is named **`chain_self_hash`** (+`chain_prev_hash`), not `hash`. Update both specs' field names. | none |
| `governance` carries the gate decision | 🟡 YELLOW | `GovernanceContext` has `approval_gate` + `evidence[]` (`event.ts:60-83`) but stock `LatticeAdapter.contribute` (`adapters/lattice/src/index.ts:77-85`) only fills validation booleans — `approval_gate`/`evidence` are stubs unless the host wires `getGateStatus`. | Aegis hook must populate `approval_gate` + `evidence` when it emits the decision event. This is *our* code (the hook), so cheap. |
| `parent_id` causal DAG | 🟡 YELLOW | `parent_id` is optional (`event.ts:117`), **not set by core emit** (`bus.ts:82-108`), only by the `withSonder` HOC (`sdk/src/with-sonder.ts:53-77`). **Not even a SQLite column** (`audit.ts:37-49`) → no descendant query possible. | Add `parent_id` column + index in `audit.ts`; populate it in the emit path; add a descendant-traversal query helper. |
| **Post-execution outcome event** (exit code / isError / error) | 🔴 RED | Gate is **pre-emit only** (`gate.ts:53-66`, `emit-pipeline.ts:96-135`). Nothing writes back a tool result. Only the `withSonder` HOC stuffs `output`/`String(err)` into freeform `payload` (`with-sonder.ts:63-79`), and only if the agent is wrapped. No structured `exit_code`/`isError`. | **This is the linchpin's linchpin.** Without an outcome event in the chain, `tool_error` and `downstream_error` have no source. Add a typed outcome-emit path (`emit-pipeline.ts` + a typed field on `event.ts`). |
| Query surface (by task/time) | 🟡 YELLOW | `AuditLog.query` filters agent_id/task_id/time (`audit.ts:183-217`); indexed on those. **No parent_id query, no descendant traversal.** | Extend `audit.ts` query layer alongside the parent_id column. |
| Structured paths/resources touched | 🔴 RED | `payload` is `unknown` (`event.ts:127`). Only `path` is `PolicyEvidenceRow.path?` (rule-match path, not affected-resource). | Rollback detection has no source. Add a typed `resources`/`paths` field on the envelope, populated at emit. |

**Net:** two RED (outcome events; resource targeting) + two YELLOW (parent_id column/query; gate-decision
population). The two YELLOW that are *our* code (hook populates `approval_gate`) are cheap; the rest are
small, well-scoped Sonder-core changes. **None are blockers to Phases 0–3** (rule corpus, hook, deterministic
gating all work without them) — they only gate the *predictive* layer. Revised sequencing:

- Phases 0–3 proceed as planned (deterministic Aegis ships first, no Sonder changes needed).
- **New Phase 3.5 (~2–3 d): Sonder labeling substrate** — add `parent_id` column+index+descendant query
  (`audit.ts`, `bus.ts`); add typed outcome event (`emit-pipeline.ts`, `event.ts`); add typed `resources`
  field; hook populates `approval_gate`. This is the gate for Phase 4.
- Phase 4 (AWM) unchanged, now with a real label source.

This is *good* news strategically: the deterministic harness (the part that matches/beats AutoHarness)
has **zero Sonder dependencies** and can ship while the labeling substrate is built in parallel.

---

## 2. Label definition — what counts as `action_failed = 1`

A decision event is labeled **failed (1)** if, within its **outcome window** (§3), any of these
fire, in priority order (first match wins, recorded in `labelReason`):

| # | Signal | Source | `labelReason` |
|---|--------|--------|---------------|
| 1 | **Human veto / undo** after the fact (operator killed the action, reverted the commit, said "no don't") | Sonder veto event w/ `parentId` = decision event; OpenClaw user-correction event | `human_veto` |
| 2 | **Non-zero exit / tool error** for the executed tool | tool-result event `exit != 0` or `isError: true` | `tool_error` |
| 3 | **Downstream error event** causally linked within window (action ran clean but caused a failure shortly after — e.g. write succeeded, next build broke) | Sonder event `severity=error` with `parentId`/causal link to the decision event | `downstream_error` |
| 4 | **Rollback signal** — a git revert/reset/restore, file restore-from-trash, or DB rollback that targets the same path/resource the action touched | correlated Sonder/tool events on overlapping `paths` | `rollback` |

Otherwise **success (0)**.

**`action_failed = NULL` (excluded from training)** when:
- The action is still inside its outcome window (not yet resolved) — *pending label*.
- The session ended abnormally (crash/disconnect) inside the window — outcome unknowable, don't
  guess (Truth-above-all: a missing label beats a fabricated one).

### 2.1 Why this multi-signal definition (not just exit code)

Exit code alone is too narrow — the most dangerous actions *succeed* (a clean `rm -rf` of the wrong
dir exits 0). Human veto + rollback + downstream-error catch the "succeeded but was wrong" class,
which is precisely where a predictor adds value over a syntactic rule. Priority order means a
human veto dominates a coincidental exit code.

### 2.2 Label confidence (soft labels, optional v2)

Signals differ in trust. `human_veto` and `tool_error` are high-confidence (≈1.0).
`downstream_error`/`rollback` are causal *inferences* (≈0.6–0.8). v1 ships hard 0/1; the schema
carries `labelConfidence` so v2 can train with sample weights without a migration.

---

## 3. Outcome window (the leak boundary)

The window is the time/event horizon after the decision in which we look for failure signals.

- **Default:** the smaller of (a) **15 minutes wall-clock**, or (b) **until the next user turn**, or
  (c) **end of session**. Whichever comes first closes the window.
- **Rationale:** long enough to catch "the write that broke the next build," short enough that we
  don't attribute an unrelated later failure to this action. Tunable per category in the constitution
  (`secrets`/`bash-critical` may warrant longer windows).
- **Tool-error & human-veto** can close the window early (we have a definitive answer).
- A row's label is **frozen** when its window closes. The nightly bake only consumes frozen rows.
  This is the walk-forward guarantee: at bake time keyed to date `D`, only rows whose window closed
  `< D` are eligible. No future leak.

---

## 4. The deny channel (don't waste the blocks)

Denied/vetoed actions never run, so they can't get an execution label — but they're still signal.
Two uses, kept **out** of the core classifier to avoid circular training:
1. **Rule-precision telemetry:** when a human *overrides* a deny ("no, that was fine, allow it"),
   that's a labeled false-positive for the rule that fired → feeds rule tuning, not the model.
2. **Counterfactual eval only:** denied rows can be scored by the model post-hoc to measure
   "would the predictor have agreed with the rule?" — analysis, never training input.

This keeps the failure classifier honest: it learns from actions that *actually executed*, not from
our own gating decisions.

---

## 5. Feature row (assembled at decision time, frozen)

Captured **at the moment of the gate decision** (no lookahead). Mirrors AWM's feature-vector
discipline. Grouped:

```jsonc
{
  // identity / target
  "decisionEventId": "sonder:...",
  "signalDate": "2026-06-14",            // walk-forward key (= decision date)
  "action_failed": null,                  // filled when window closes
  "labelReason": null,
  "labelConfidence": null,

  // --- FEATURES (all known at/before decision) ---
  "tool": "Bash",                         // categorical
  "ruleSeverityMax": "high",             // from Aegis match output; "none" if no match
  "ruleCategoriesHit": ["bash"],         // multi-hot
  "ruleIdsHit": ["bash.git-force-push"], // for high-cardinality embedding later

  // command-shape (the cheap, high-signal stuff AutoHarness's regex sees)
  "cmdLength": 42,
  "combinatorCount": 1,                    // ; && || | $() ` > <
  "pathsTouched": 1,
  "writesVsReads": "write",
  "touchesGit": false,
  "touchesSystemDir": false,
  "newFile": false,

  // context
  "agentId": "rook",
  "taskDepth": 3,                          // parentId chain length
  "priorFailuresThisSession": 0,
  "sessionHealthRegime": "clean",        // clean | recovering | thrashing  (the AWM-regime analog)

  // Engram priors (the memory edge nobody else has)
  "histFailRate_toolPath": 0.04,          // historical fail-rate for (tool, path-prefix)
  "secsSinceLastFailHere": 86400,
  "engramPriorN": 37                       // sample size behind the prior (for shrinkage)
}
```

**Leak guards baked into extraction:**
- Anything timestamped after `decisionEventId` is forbidden in features. The extractor asserts this.
- Engram priors must be queried **as-of `signalDate`**, not "now" — otherwise today's outcomes leak
  into a past row's prior. (Same bug class as AWM's 2026-04-21 stale-cache fix; we inherit the lesson.)

---

## 6. `sessionHealthRegime` — the regime analog

Direct port of AWM's regime gate concept. A session-level state from rolling outcomes:
- **clean** — recent actions succeeding; normal thresholds.
- **recovering** — a recent failure, now succeeding again; mild tightening.
- **thrashing** — repeated failures in a short window; **tighten the gate hard** (lower the
  `askAtOrAbove`/`denyAtOrAbove` thresholds via a profile). This is the "stop digging" safety valve —
  exactly mirrors AWM zeroing weights outside active regimes.

Defined by simple counters over the last N actions in-session (N + thresholds in constitution).

---

## 7. Training loop (inherits AWM, bake-first from day one)

- **Source:** the Sonder signed chain. Each frozen row = one training example. Free, growing, labeled.
- **Bake nightly**, keyed `(signalDate - 1)`, persist models + calibrators (NOT per-call refit — the
  build plan and AWM's own open-question both mandate this; Aegis is bake-first from v1).
- **Inference < 60ms** at gate time via warm endpoint (build-plan seam option 1), falling back to the
  **rule-derived prior** when AWM is cold/unavailable — `P(failure) = baseRate[ruleSeverityMax]`. This
  is what makes Aegis degrade gracefully to pure-Lattice behavior with zero data (cold start).
- **Calibration is mandatory** — reuse AWM's calibration so `0.80` means 80%. An uncalibrated score
  feeding a hard `deny` threshold is a footgun.

### 7.1 Cold-start base rates (until we have ≥ N labeled rows)
```
critical → 0.90   high → 0.45   medium → 0.20   low → 0.03   none → 0.01
```
Pure priors; replaced per-segment as real data accrues. Tunable in constitution.

---

## 8. Minimal viable dataset before we trust the model
- Don't let AWM **escalate** (allow→ask, ask→deny) until the calibrator has ≥ a floor of frozen rows
  per severity bucket AND calibration error (ECE) is below a set bar on held-out walk-forward folds.
- Below that floor, AWM runs in **shadow mode**: it scores and logs `pFailure`, the gate ignores it,
  we accumulate labels + measure calibration. Flip to live only when it beats the rule-only baseline
  on a walk-forward backtest. (Same gate-before-trust discipline as the equity runner.)

---

## 8.5 Outcome-window default — DECIDED (2026-06-14)

**Decision: `min(next user turn, 10 min wall-clock, end of session)`, with two early-close shortcuts
and one per-category override.** Reasoning:

- **Why "next user turn" is the primary boundary, not a fixed clock.** An agent action's blast radius
  is almost always resolved before the human speaks again — the next turn either builds on the success
  or reacts to the failure ("that broke X", "undo that"). The turn boundary is the natural causal
  horizon and it's *adaptive*: a fast back-and-forth gets a tight window, a long autonomous run gets a
  longer one. It also captures the highest-signal label (`human_veto`) by construction.
- **Why a 10-min wall-clock cap on top.** Autonomous/overnight runs can go many actions deep with no
  human turn for hours. Without a cap, an action emitted at 02:00 would absorb a failure at 05:00 and
  mislabel an unrelated event as its consequence — the exact attribution error that poisons the model.
  10 min is long enough to catch "the write that broke the next build/test cycle" (CI/build feedback
  loops are typically minutes) and short enough to keep causal attribution tight. I moved this **down
  from 15 to 10 min** vs the spec draft: the failure signals we trust most (tool_error, human_veto)
  close the window early anyway, so the cap only governs the weak `downstream_error` signal, where a
  *tighter* horizon is safer (fewer false causal links).
- **Early-close shortcuts (definitive answers stop the clock):** a `tool_error` or a `human_veto`
  whose parent chains to the decision event freezes the label immediately — we already know the
  outcome, no reason to keep the window open.
- **Per-category override, not a global knob.** `bash`-critical and `secrets` actions get a longer cap
  (recommend 30 min) — their failure modes (a leaked key used downstream, a destructive command whose
  damage surfaces later) have genuinely longer fuses. Everything else uses the 10-min default. This
  lives in the constitution (`window.byCategory`), defaulting to the global value.
- **Walk-forward integrity is preserved** regardless of length: a row is only eligible for the nightly
  bake once its window has *closed* (§3, "frozen"). A longer window just delays eligibility; it never
  leaks future data into a feature.

Net: adaptive turn-based primary horizon + a conservative 10-min cap (30 for high-blast categories) +
definitive-answer early-close. Tighter than the draft, and it fails toward *under*-attributing
`downstream_error` (the weakest signal) rather than over-attributing it.

## 9. Open decisions
- ~~Window length default~~ — **DECIDED, see §8.5.**
- **`downstream_error` causal linking.** Requires `parentId`/causal edges on Sonder events to be
  reliable. Audit whether the chain already carries enough causality, or if Aegis must add edges.
- **Soft labels in v1 or v2?** Schema supports both; recommend hard 0/1 in v1, sample-weights v2.
- **Shadow-mode floor (min rows + ECE bar).** Pick concrete numbers once we see ingest rate.
- **Privacy:** rows contain command strings/paths. The training store inherits Engram's scoping;
  confirm no cross-agent leakage if the OSS Aegis ships a shared model (likely ship rules public,
  model local/per-deployment).

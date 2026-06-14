# Build Plan: "Aegis" — an AutoHarness-killer reinforced with the heybeaux stack

> Draft v1 · 2026-06-14 · Owner: @beauxwalton
> Working codename **Aegis** (rename freely). Goal: a governance harness that is strictly more
> robust than AutoHarness by reusing what's good (its rule corpus + config schema), discarding
> what's weak (its audit chain, broken installer, Python subprocess hooks), and adding a
> capability AutoHarness does not have: **predictive gating via AWM** — statistical estimation
> of failure likelihood *before* an action runs.

---

## 0. Thesis in one paragraph

AutoHarness is a *reactive* rules engine: it matches a tool call against ~84 regex patterns and
returns allow/ask/deny. We already have a stronger substrate — **Sonder** (signed event bus +
`checkGate` veto), **Lattice** (gate policy), **Engram** (memory) — and a unique asset in **AWM**
(a calibrated ML predictor already running in production as the *intent* faculty). Aegis = the
AutoHarness rule corpus, ported native to Lattice, enforced through Sonder's real veto hook, with
**AWM scoring P(failure)** for each pending action and feeding that probability into the gate
decision. We ship the thing AutoHarness's name promises ("harness tuning") but actually delivers
statistically, not just pattern-matching.

---

## 1. What we harvest from AutoHarness (data, not code)

Source clone: `~/projects/AutoHarness`. All of this ports as **data or spec**, not Python.

| Asset | Source file | Port target | Notes |
|---|---|---|---|
| 84 risk regex rules | `autoharness/rules/builtin.py` | Lattice rule-pack JSON | pure data; needs Python `re` → JS RegExp dialect pass |
| 19 prompt-injection + PII patterns | `autoharness/validation/rails.py` | Lattice rule-pack JSON | watch lookbehind `(?<!...)` — needs modern V8 |
| `_is_safe_command` allowlist | `autoharness/core/risk.py:293-317` | Lattice `safeCommand.ts` | reimplement verbatim — ~30 lines, language-neutral |
| Constitution YAML schema | `autoharness/core/constitution.py` | Lattice gate-policy config | 3-layer cascade + deep-merge-by-id + level→action table |
| 8-priority permission cascade | `autoharness/core/permissions.py` | Lattice `getGateStatus` logic | "hook-deny always wins, hook-allow never overrides constitution-deny" invariant |
| Progressive session trust | `autoharness/core/trust.py` | Lattice session state | auto-approve-after-first-ask state machine |
| 949-test suite | `tests/` | **port as TS spec** | the tests ARE the specification; translate, don't trust upstream |

### What we explicitly DO NOT take
- **Audit/verification** (`core/audit.py`) — no `prev_hash`, no signature, not tamper-evident.
  Sonder's ed25519 signed chain is strictly stronger. Keep ours.
- **Client wrappers / `wrap.py`** — bound to Python SDK object shapes; fragile.
- **The installer** — both Claude Code installers are broken (wrong settings.json schema; dead
  second installer references a non-existent `audit --stdin` command). We write our own correct hook.
- **`marketplace/`, `anti_distillation.py`, `sentiment.py`, `cli/main.py:_evaluate_tool_call`** —
  dead/aspirational (~30% of the 26K LOC).

---

## 2. Target architecture

```
                       OpenClaw / Claude Code
                    (PreToolUse hook, correct schema)
                                 │  tool JSON on stdin
                                 ▼
                    ┌──────────────────────────────┐
                    │   aegis-hook (TS, warm)      │   exit 2 = block / 0 = allow
                    │   → Sonder runtime.checkGate │   reason on stderr
                    └───────────────┬──────────────┘
                                    │ SonderEventV2 (intent + governance fields)
              ┌─────────────────────┼─────────────────────────┐
              ▼                     ▼                          ▼
     ┌────────────────┐   ┌──────────────────┐      ┌──────────────────┐
     │ LATTICE        │   │ AWM (predictive) │      │ ENGRAM (memory)  │
     │ rule-pack match│   │ P(failure | act) │      │ recall priors:   │
     │ + safeCommand  │   │ calibrated score │      │ "did this tool   │
     │ + perm cascade │◀──│ feeds threshold  │◀────▶│  fail here before"│
     └───────┬────────┘   └──────────────────┘      └──────────────────┘
             │ allow / ask / deny + risk + P(fail)
             ▼
     SONDER signed audit chain (ed25519) — every decision recorded
```

**Division of labor (respect existing fencing arch, 2026-05-14):**
- **Sonder** owns the mechanism: the pre-emit `checkGate` veto, signing, the audit chain. No policy.
- **Lattice** owns the *deterministic* policy: rule matching, safe-command allowlist, permission
  cascade, the constitution config. Returns pending/clear/deny.
- **AWM** owns the *probabilistic* layer: given a candidate action + context, returns a calibrated
  P(failure) (and/or P(gate-pass)). This is the new differentiator.
- **Engram** supplies priors: historical outcomes for "this tool / this path / this repo" that AWM
  uses as features and that the gate can use directly ("this exact command failed 3× here").

---

## 3. The AWM predictive layer (the differentiator) — design

AWM today predicts `direction_5d` (boolean: >1% forward return in 5 days) via walk-forward
LR + XGBoost + regime ensemble. The machinery transfers almost 1:1 to action-outcome prediction.

**Reframe the target.** Instead of `direction_5d`, the target becomes `action_failed` — a boolean
label: did this tool call lead to a bad outcome (error, rollback, human veto, or a downstream
SonderEvent marked failure)?

**Feature vector for a pending action** (assembled from the SonderEvent + Engram):
- tool name (categorical), risk level from Lattice (ordinal), risk category
- command shape features: length, # of shell combinators, # of paths touched, writes-vs-reads
- path features: inside repo? touches `.git`/`node_modules`/system dirs? new vs existing file?
- context features: agent_id, task depth (parent_id chain length), # of prior failures this session
- Engram priors: historical fail-rate for (tool, path-prefix), recency of last failure here
- "regime" analog: session health regime (clean / recovering / thrashing) — directly mirrors AWM's
  regime gate. When the session is "thrashing" (repeated failures), tighten the gate.

**Output:** calibrated `P(failure) ∈ [0,1]` + a confidence band. Calibration matters — reuse AWM's
existing calibration approach so the probability is trustworthy, not just a score.

**How it feeds the gate (Lattice threshold table, extended):**
```
deterministic deny           → DENY (always; hard rules win)
P(failure) ≥ 0.80            → DENY  (predicted near-certain failure)
0.40 ≤ P(failure) < 0.80     → ASK   (human/lattice approval)
P(failure) < 0.40 + low risk → ALLOW
```
Thresholds live in the constitution config so they're tunable per agent/profile.

**Training loop (walk-forward, same discipline as the equity runner):**
- Every Sonder action + its eventual outcome is a labeled row in the audit chain → free training data.
- Nightly bake (NOT per-call refit — learn from AWM's runtime lesson): fit models offline, persist,
  serve signal-time inference in <60ms. AWM's deep card already flags the bake-vs-refit refactor;
  Aegis should be bake-first from day one.
- Cold-start: before we have data, P(failure) defaults to a rule-derived prior (risk level → base
  rate) so the gate degrades gracefully to pure-Lattice behavior.

**Cross-language seam:** AWM is Python, the hook is TS. Don't subprocess per call (AutoHarness's
mistake). Options, in preference order:
1. **AWM serves a warm local inference endpoint** (load model once, score over HTTP/UDS, <60ms).
   The TS hook calls it; falls back to rule-prior on timeout (fail-closed on governance, per Sonder's
   2s adapter rule).
2. Export the trained model to ONNX → run inference in TS. Removes the process boundary entirely.
   Better long-term; more upfront work.
3. Nightly bake writes a static score table / coefficients that TS reads directly (works if the model
   stays linear-ish). Cheapest, least flexible.

Start with (1), migrate to (2) once the feature set stabilizes.

---

## 4. Robustness improvements over AutoHarness (so it's genuinely "better")

The assessors found AutoHarness's regex engine is bypassable. Aegis closes these:
- **Decode-then-rescan**: base64/hex/`$'\xNN'` decode pass before matching (catches
  `echo cm0gLXJmIC8=|base64 -d|sh`).
- **Variable resolution**: light shell-var expansion (`X=rm; $X -rf /`) before matching.
- **AST-assist for code tools** (`python -c`, `node -e`): parse the inline program, don't just regex it.
- **Predictive backstop**: even when no rule matches, a high P(failure) from AWM still triggers ASK —
  this is the structural advantage. Reactive rules can't catch novel-but-doomed actions; the predictor can.

---

## 5. Phased delivery & estimates

Total rough budget: **~14–20 person-days** for v1 (matches assessor estimate for strategy B + the AWM layer).

**Phase 0 — Spec & scaffolding (1–2 d)**
- New Lattice package `@heybeaux/lattice-aegis` (or fold into existing gate-policy pkg).
- Define the rule-pack JSON schema + constitution config schema (port from `core/constitution.py`).

**Phase 1 — Port the deterministic corpus (3–4 d)**
- Port 84 rules + rails patterns → JSON rule packs; regex-dialect pass Python→JS.
- Reimplement `_is_safe_command` + permission cascade in TS.
- Port the relevant AutoHarness tests as the TS spec; go green.

**Phase 2 — Correct harness integration (2–3 d)**
- `aegis-hook` TS binary: reads PreToolUse JSON on stdin, calls Sonder `checkGate`, exits 2/0,
  reason on **stderr**. Treat `ask` as block (exit 2) — do NOT silently allow like AutoHarness.
- Installer that writes the **correct** `{matcher, hooks:[{type,command}]}` settings.json shape.
- Warm-process design (no cold-start per call).

**Phase 3 — Wire Sonder + Engram (2–3 d)**
- Gate decisions emit SonderEvents → signed audit chain (free training labels).
- Engram priors: query historical (tool, path) outcomes; expose as gate input + AWM feature.

**Phase 3.5 — Sonder labeling substrate (2–3 d) [ADDED 2026-06-14 after chain audit]**
Gate for Phase 4. Source audit found the chain can't yet mint failure labels:
- Add `parent_id` column + index + descendant-traversal query (`audit.ts`, `bus.ts`).
- Add a **typed post-execution outcome event** (exit code / isError / error) — RED gap, gate is
  pre-emit only today (`emit-pipeline.ts`, `types/event.ts`).
- Add a typed `resources`/`paths` field on the envelope for rollback detection (RED gap).
- Aegis hook populates `governance.approval_gate` + `evidence` (stub today in `LatticeAdapter`).
- Field-name fix: the chain hash is `chain_self_hash` (+`chain_prev_hash`), not `hash`.
Full evidence in `aegis-action-failed-label-spec-2026-06-14.md` §1.5. Phases 0–3 have **zero** Sonder
deps and ship in parallel with this.

**Phase 4 — AWM predictive layer (4–6 d)**
- Define `action_failed` label + feature extractor over the Sonder audit chain.
- Warm inference endpoint (option 1 above) + calibration.
- Threshold integration into Lattice gate table.
- Cold-start rule-prior fallback.

**Phase 5 — Robustness hardening (2 d)**
- Decode-then-rescan, var resolution, AST-assist for code tools.

---

## 6. Open questions (decide before/early in build)

- **Codename + repo home.** New repo, or package inside `lattice`? (Leaning: package in lattice,
  since gate policy lives there.)
- ~~**Label definition for `action_failed`.**~~ **SPEC'D** — see `aegis-action-failed-label-spec`.
  Multi-signal (human veto > tool error > downstream error > rollback), leak-free windowing.
- ~~**Outcome-window default.**~~ **DECIDED** — `min(next turn, 10 min, EOS)` + per-category cap.
  Reasoning in label spec §8.5.
- **Sonder labeling substrate (NEW, from chain audit).** Two RED gaps (no post-exec outcome event;
  no structured resource/paths field) + parent_id not indexed. Now Phase 3.5. Gates Phase 4 only.
- **Inference seam.** Start with warm HTTP/UDS endpoint vs jump straight to ONNX-in-TS?
- **Do we publish it?** AutoHarness is MIT and getting traction as a "standard." An OSS Aegis with a
  real predictive layer is a credible category-killer — but that's a positioning call, not a tech one.
- **Threshold defaults.** 0.40/0.80 above are placeholders — calibrate against real audit data.

---

## 7. One-line summary

Port AutoHarness's rule corpus + config schema into Lattice, enforce it through Sonder's real signed
veto, give it memory via Engram, and—uniquely—let AWM predict P(failure) before each action so the
harness *anticipates* danger instead of only pattern-matching it.

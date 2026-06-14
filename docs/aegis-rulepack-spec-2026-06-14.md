# Aegis Rule-Pack Format — Spec v1

> 2026-06-14 · Unblocks Build Plan Phase 0/1 · Companion to `autoharness-killer-build-plan-2026-06-14.md`
> Defines the JSON schema we port AutoHarness's 84 risk rules + injection rails into, the
> compile/validation contract, and the constitution overlay that maps matches → gate actions.

---

## 0. Why a format (not just porting Python)

AutoHarness stores rules as Python `RiskPattern(pattern, description, category)` literals grouped
`BUILTIN_RULES[category][risk_level]`. That's code. We want **data**: versioned, validated,
hot-loadable rule packs that Lattice reads, that ship as the OSS corpus, and that third parties can
extend without touching engine code. The engine (`@heybeaux/lattice-aegis`) is the only code; rules
are JSON.

Grounding facts (verified against source 2026-06-14):
- `builtin.py` contains **exactly 84** `RiskPattern` entries, grouped by category (`bash`,
  `file_write`, `file_read`, `secrets_in_content`) then risk level (`critical|high|medium|low`).
- `validation/rails.py` stores injection patterns differently — bare regex strings in
  `PromptInjectionRail._DEFAULT_PATTERNS` (a `ClassVar[list[str]]`), no per-pattern metadata.
- **Risk-level mismatch to fix:** lattice's `RiskLevel = 'low' | 'medium' | 'high'` (no `critical`).
  AutoHarness has `critical`. Decision below (§4) — we **add `critical`** to the Aegis rule severity
  enum but keep it distinct from lattice's contract `RiskLevel` (the rule pack has its own severity;
  it maps into the gate, it is not the contract type).

---

## 1. Rule-pack file shape

One pack = one JSON file. A deployment loads many packs (builtin + user + project), merged by §3.

```jsonc
{
  "$schema": "https://lattice.heybeaux.dev/schema/aegis-rulepack-1.json",
  "packId": "aegis-builtin",          // unique; merge identity is (packId, rule.id)
  "version": "1.0.0",                  // semver of the pack content
  "source": "ported:autoharness@0.1.0",// provenance for the OSS corpus
  "engineMin": "1.0.0",               // min aegis engine that understands this pack
  "rules": [ /* Rule[] */ ]
}
```

### 1.1 Rule object

```jsonc
{
  "id": "bash.rm-rf-root",            // stable, namespaced, kebab; THE merge/override key
  "category": "bash",                 // bash | file_write | file_read | secrets | injection | pii
  "severity": "critical",            // critical | high | medium | low
  "description": "rm -rf / — recursive force-delete from root",
  "match": {
    "kind": "regex",                 // regex | substring | ast (ast = phase 5)
    "pattern": "\\brm\\s+-[^\\s]*r[^\\s]*f[^\\s]*\\s+/|\\brm\\s+-[^\\s]*f[^\\s]*r[^\\s]*\\s+/",
    "flags": "i",                    // subset of JS flags; see §2.2
    "target": "command"             // command | content | path | argv  (what string we test)
  },
  "appliesTo": ["Bash"],             // tool-name allowlist; ["*"] = any tool. Maps Claude Code tool names.
  "remediation": "Scope the delete to an explicit project subdir.", // optional, shown in ASK/DENY reason
  "references": ["CWE-77"],          // optional
  "enabled": true                     // packs can ship disabled rules; overlays can flip
}
```

**Design notes**
- `id` is the contract. It's how a project overlay disables/retunes a builtin rule without editing it.
  Porting builtins: derive ids from category + a slug of the description (`bash.rm-rf-root`,
  `bash.fork-bomb`, `secrets.anthropic-key`).
- `target` decouples the rule from how the engine assembles strings. A bash rule tests the assembled
  `command`; a secret rule tests `content`; a path-guard rule tests each `path` in `argv`.
- `appliesTo` replaces AutoHarness's implicit category→tool coupling. Explicit > implicit.

---

## 2. Compile + dialect contract

### 2.1 Python `re` → JS `RegExp` port pass (Phase 1 deliverable)

Most builtins are vanilla and port 1:1. Known divergences to handle mechanically:
- **Inline flags** `(?i)`, `(?m)` at pattern start → strip, move to `match.flags`.
- **Possessive quantifiers / atomic groups** (`a++`, `(?>...)`) — not in V8 < recent; AutoHarness
  doesn't appear to use them, but the porter must **fail the build** if it sees one, not silently drop.
- **Lookbehind** `(?<!...)` / `(?<=...)` — supported in modern V8/Node ≥ engineMin's runtime; the
  build plan already flagged rails uses these. Pin Node version in CI; test each lookbehind rule.
- **`\b` word boundary** — identical semantics, ports clean (this is what makes `cat` ≠ `catastrophe`).
- **Unicode**: AutoHarness has zero-width / homoglyph injection rules. Force `u` flag on those and add
  a porter assertion that the pattern compiles under `u`.

The porter is a one-shot script with a **golden test**: feed each rule its AutoHarness positive +
negative test strings (extracted from `tests/`) and assert match parity. This is how the 949-test
suite becomes our spec — we don't trust the regex translated by eye.

### 2.2 Allowed `flags`
`i`, `m`, `s`, `u` only. **No `g`** (stateful `lastIndex` is a footgun for a match-once engine).
The compiler rejects any other flag at load time.

### 2.3 ReDoS guard
Every rule is run under a per-match timeout budget (the engine is on the hot path of every tool
call). Catastrophic-backtracking patterns must be caught at **pack-load time**, not runtime: the
loader runs each compiled regex against a set of adversarial filler strings with a deadline and
refuses to load a pack containing a pattern that blows the budget. Fail-closed on the pack, log loudly.

---

## 3. Merge / cascade semantics (constitution overlay)

Three layers, lowest→highest precedence (mirrors AutoHarness's user→project→local cascade):

1. **builtin packs** (shipped with engine) — the ported corpus.
2. **user pack** (`~/.config/aegis/rules.json`) — operator-wide.
3. **project pack** (`./.aegis/rules.json`) — repo-local, wins.

Merge is **by `(packId, rule.id)`**, deep-merge of fields:
- A higher layer with the same `id` **overrides** matching fields (e.g. flip `enabled:false`, bump
  `severity`, tweak `appliesTo`). It does NOT need to restate the whole rule.
- A higher layer with a **new** `id` **adds** a rule.
- There is no "delete" — you disable (`enabled:false`). Keeps provenance auditable.

**Invariant (ported from AutoHarness permission cascade, the one piece of that logic worth keeping):**
> A higher layer may make a rule **stricter** freely. Making a builtin `critical` rule *less* strict
> (disable, or lower severity) requires `allowDowngrade: true` on the overlay rule — otherwise the
> loader warns and keeps the stricter builtin. Prevents a careless project overlay from silently
> defanging `rm -rf /`.

---

## 4. Severity → gate action (the constitution table)

The rule pack carries **severity**; the **constitution config** (separate file, separate spec, but
sketched here because it's the consumer) maps severity + the AWM `P(failure)` into a gate action.

```jsonc
// .aegis/constitution.json  (excerpt — full schema is its own Phase-0 deliverable)
{
  "thresholds": {
    "severity": {                 // deterministic floor (Lattice)
      "critical": "deny",
      "high":     "ask",
      "medium":   "ask",
      "low":      "allow"
    },
    "prediction": {               // AWM overlay — can only ESCALATE, never relax, the severity floor
      "denyAtOrAbove": 0.80,
      "askAtOrAbove":  0.40
    }
  },
  "profiles": { /* per-agent overrides, same shape */ }
}
```

**Combination rule (this is the heart of Aegis and must be unambiguous):**
```
action = strictest_of(
    severity_table[matched_rule.severity],   // deterministic; critical always wins
    prediction_table[P(failure)]             // probabilistic; can escalate allow→ask→deny
)
order: deny > ask > allow
```
So AWM can turn a `low`-severity-but-doomed action into `ask`, but can **never** turn a `critical`
match into `allow`. Hard rules are a floor; the predictor is a backstop that only tightens. This is
the safety property we publish.

Mapping back to lattice's existing types: the rule severity enum (`critical|high|medium|low`) is
**internal to Aegis rule packs**. The gate action (`allow|ask|deny`) is what Aegis returns to the
Sonder hook. Lattice's contract-level `RiskLevel` (`low|medium|high`) is unchanged — Aegis severity
is a superset used only for rule classification, not the contract.

---

## 5. Engine output (what the hook consumes)

A single evaluation returns:

```jsonc
{
  "action": "ask",                  // allow | ask | deny
  "decidedBy": "severity",         // severity | prediction | both
  "matches": [                      // every rule that fired (audit-grade)
    { "id": "bash.git-force-push", "severity": "high", "target": "command" }
  ],
  "prediction": { "pFailure": 0.31, "confidence": 0.7, "source": "awm|prior" },
  "reason": "git push --force — destructive remote rewrite",  // human-readable, → hook stderr
  "ruleVersions": ["aegis-builtin@1.0.0"]                     // for the signed audit chain
}
```

This object is exactly what gets emitted into Sonder's signed chain (§Build-Plan Phase 3) — which
makes it a **labeled training row** once the eventual outcome is stapled on (see the `action_failed`
label spec). The two specs meet here.

---

## 6. Phase-1 port checklist (maps to build plan)

- [ ] Generate `aegis-builtin.json` from `builtin.py` — 84 rules, ids derived, severity carried.
- [ ] Generate `aegis-injection.json` from `rails.py` `_DEFAULT_PATTERNS` (+ PII patterns) — these
      need ids/descriptions synthesized since the source has none.
- [ ] Write the porter golden test: AutoHarness `tests/` positives/negatives → parity assertion.
- [ ] Implement loader: schema-validate, regex-compile, flag-restrict, ReDoS budget, downgrade guard.
- [ ] Implement merge (§3) with the strictness invariant.
- [ ] Implement evaluator → §5 output object.
- [ ] Port the relevant AutoHarness permission-cascade tests as the TS spec; go green.

## 7. Open decisions
- **`critical` in lattice?** Recommend: keep it Aegis-rule-internal (done above), do NOT widen the
  contract `RiskLevel`. Confirm.
- **Tool-name mapping.** `appliesTo` uses Claude Code / OpenClaw tool names (`Bash`, `Write`, `Edit`,
  `Read`). Need the canonical list to validate `appliesTo` at load. (OpenClaw tool registry.)
- **Pack signing.** Do builtin packs get signed (ed25519, same as Sonder chain) so a tampered rule
  pack is detectable? Leaning yes for the published corpus.

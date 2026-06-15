# Aegis ⇄ AutoHarness parity — risk corpus conformance

**Date:** 2026-06-14
**AutoHarness source:** `github.com/aiming-lab/AutoHarness` @ `3561e468f9ca9f9bf282512e695bd32e4e90fef4`
**Aegis engine:** `@heybeaux/lattice-aegis` (`packages/aegis`), evaluated via the same
`evaluate(call, rules, { preprocess: true })` path the Sonder hook uses in production.
**Harness:** `packages/aegis-bench/src/parity.ts` + `test/parity-autoharness.test.ts`
**Machine-readable report:** `packages/aegis-bench/results/parity-autoharness-2026-06-14.json`

Every number below comes from a real run executed on 2026-06-14. No number is estimated.
(Secret-token examples in this document are redacted/defanged so Aegis's own write-hook
doesn't flag the file — a happy confirmation that our content-scan path actually works.)

---

## Headline

> **Aegis matches 86.4% (38 / 44) of AutoHarness's risk-classification corpus**
> (`tests/test_risk.py`), with **3 cases excluded as framework-API tests with no
> data-only-engine analogue** (listed). The 6 divergences are a single coherent gap —
> secrets embedded in **bash command strings** — documented below. Not fixed; flagged
> for a decision.

| metric | value |
|---|---|
| Cases extracted from `test_risk.py` (AST) | 47 |
| Excluded (framework-API, no analogue) | 3 |
| **Applicable corpus cases** | **44** |
| Passed | 38 |
| Failed (divergences) | 6 |
| **Parity** | **86.4%** |

### What "parity" means here

AutoHarness's `test_risk.py` asserts on `RiskAssessment.level` — a `RiskLevel` severity
(`low|medium|high|critical`). Our engine emits an `Evaluation`; our equivalent of "level"
is the **max severity across rule hits** (or `low` when nothing matches — the same floor
AutoHarness uses for a clean call). The parity axis is **their expected RiskLevel vs our
max-severity**. We deliberately do *not* compare the allow/ask/deny mapping: the two
projects ship different constitution tables (AutoHarness: high to deny; Aegis: high to ask),
and that's a policy choice, not a corpus disagreement.

---

## Scope: why `test_risk.py` is THE parity surface

AutoHarness's suite is **958 tests across 24 files** (we ran it: **939 passed, 19 failed**
on a clean install — the 19 failures are `pytest-asyncio` not being installed, i.e.
environmental, not corpus). Of those 24 files, exactly **one** — `test_risk.py` — is the
input-to-severity risk corpus that Aegis reimplements. It is the `RiskClassifier` spec: feed
a tool call, assert its risk level. That is precisely what `evaluate()` + the rule packs do.

The other 23 files test the **Python framework around** the classifier — agent loops,
orchestration, the hook I/O protocol, the CLI init wizard, pydantic type models,
observability, the skill/tool/prompt subsystems, etc. We did **not** port those subsystems;
Aegis is a data-only rule engine wired into Sonder, not a re-host of AutoHarness's runtime.
Claiming parity on them would be dishonest. They are enumerated in the exclusion list.

---

## Exclusion list

### A. Per-case exclusions within `test_risk.py` (3 of 48 tests)

These run against the corpus file but test the Python `RiskClassifier` **input-validation
API**, which a data-only engine doesn't expose (our rules are static JSON validated at load
by `loadPack`, not mutated through a runtime setter):

| Test | Reason |
|---|---|
| `TestRiskClassifierMisc::test_invalid_mode_rejected` | Tests `RiskClassifier(mode=...)` constructor rejection. Aegis has no runtime `mode` param. |
| `TestCustomRules::test_invalid_level_rejected` | Tests `add_custom_rule()` rejecting a bad level. Aegis validates rule severity at JSON load, not via a runtime setter. |
| `TestCustomRules::test_invalid_regex_rejected` | Tests `add_custom_rule()` rejecting a bad regex. Same — load-time concern, no runtime setter. |

> Note: the 48th test, `test_get_safe_commands`, inspects the classifier's safe-list and is
> not a classification case; the AST extractor correctly produces no RiskLevel assertion for
> it, so it never enters the applicable set (not counted as excluded *or* applicable).

### B. Whole-file exclusions (23 of 24 files) — framework subsystems we did not port

We claim **no** parity on these; they test AutoHarness's Python runtime, not the risk
corpus. (`def test_` count per file in the Tests column.)

| File | Tests | Why excluded |
|---|---|---|
| `test_agent_loop.py` | 26 | AgentLoop integration layer — a runtime we didn't port. |
| `test_agent_orchestration.py` | 50 | Phase-5 agent orchestration engine — not ported. |
| `test_audit.py` | 25 | `AuditEngine` — Aegis defers audit to Sonder's signed event bus. |
| `test_cli_wrap.py` | 15 | CLI `wrap`/`report` commands — Aegis ships as a hook, not this CLI. |
| `test_constitution.py` | 34 | Constitution YAML loader/merger — Aegis uses JSON rule packs + a different merge model. |
| `test_hooks.py` | 62 | `HookRegistry` + AutoHarness's own shell-hook protocol — Aegis targets the Claude Code / Sonder hook contract instead. |
| `test_init_wizard.py` | 33 | Interactive project-detection init wizard — not ported. |
| `test_integration.py` | 74 | End-to-end wiring of the above subsystems — not our runtime. |
| `test_multi_agent.py` | 43 | `MultiAgentGovernor`/`AgentProfile` — not ported. |
| `test_new_features.py` | 25 | "Upcoming features": anti-distillation, sentiment — explicitly NOT ported (dead/cruft per the port plan). |
| `test_observability.py` | 36 | Tracing/metrics subsystem — not ported. |
| `test_permissions.py` | 26 | `PermissionEngine` (glob/path allowlists) — separate concern from risk classification. |
| `test_phases_6_to_9.py` | 72 | Session/hook-profiles/tasks/recovery phases — not ported. |
| `test_pipeline.py` | 37 | `ToolGovernancePipeline` end-to-end incl. async executors + hook firing — Aegis's pipeline is the hook, evaluated separately. Its *decision* cases overlap the `test_risk.py` corpus already counted. |
| `test_pipeline_modes.py` | 35 | Three-tier core/standard/enhanced mode system — not ported. |
| `test_prompt_system.py` | 33 | System-prompt architecture (Phase 2) — not ported. |
| `test_skill_system.py` | 30 | Skill system (Phase 4) — not ported. |
| `test_tool_system.py` | 43 | Tool system (Phase 3), incl. speculative/async classifiers — not ported. |
| `test_turn_governor.py` | 19 | Turn-level governance — not ported. |
| `test_types.py` | 53 | Pydantic model/enum tests — Aegis has its own TS type contract. |
| `test_v2_features.py` | 34 | v0.2 artifacts/progress/rails/cost-attribution — not ported. |
| `test_validation.py` | 39 | Structured-output validation system — not ported. |
| `test_verification.py` | 57 | Verification engine — not ported. |

We are **not** padding the pass rate by over-excluding: the only file whose subject matter
is the risk corpus is `test_risk.py`, and we ran **all** of its classification cases. The
excluded files test code that has no counterpart in Aegis by design.

---

## Divergences (the 6 failures) — findings, not bugs to paper over

All six are the **same** finding: **secrets embedded in a bash `command` string are not
detected by Aegis.** (Secret values redacted below; see the JSON report for the verbatim
inputs as extracted from their tests.)

| Test | Input shape (`Bash` command) | AutoHarness | Aegis |
|---|---|---|---|
| `test_openai_key` | `curl` with an `sk-` OpenAI key in an Authorization header | critical | low |
| `test_github_pat` | `export TOKEN=` a `ghp_` GitHub PAT | critical | low |
| `test_aws_key` | `export AWS_KEY=` an `AKIA` access key | critical | low |
| `test_private_key_block` | `printf` of an RSA private-key PEM block | critical | low |
| `test_slack_token` | `curl` with an `xoxb-` Slack bearer token | critical | low |
| `test_database_url_with_password` | `export DB=` a postgres URL with inline password | critical | low |

### Root cause

Aegis's secret rules (`rulepacks/secrets.json`) are `match.target: "content"` and
`appliesTo: ["Write", "Edit"]` — they scan **file content** on write/edit tools. They do
**not** scan the `command` string of a `Bash` call. AutoHarness's `RiskClassifier.classify`
additionally joins *all* string values of `tool_input` and runs secret patterns over them,
so it catches a secret echoed/exported/curl'd on a shell line.

**Our secret patterns themselves are correct** — the sibling content case
`test_classify_content_jwt` (a JWT scanned as content) **passes**, and `test_no_secret_clean`
passes. The gap is purely the **scan surface**: we don't run secret rules against bash
command text. (Proof the patterns fire: writing *this very results file* was initially
DENIED by our own hook three times — once each for the GitHub PAT, the private-key block,
and the DB-URL examples — until the literals were redacted.)

### This is a real product decision, not a harness artifact

- Closing it is mechanical: add `Bash`/`command`-targeted variants of the secrets rules (or
  broaden `appliesTo` + add a `command` target). That would lift parity to **100% of the
  applicable corpus (44/44)**.
- But it has a real false-positive surface (e.g. a legitimate `curl` with a bearer token in
  a dev script), and it changes what the gate asks on. **Per the no-force-pass rule, the
  engine was left unchanged.** This is surfaced for an explicit decision, not silently
  patched.

---

## Honesty notes

- **Baseline is real:** we installed AutoHarness in a Python 3.12 venv and ran its suite —
  `939 passed, 19 failed` (async-only, env-caused). Their corpus file `test_risk.py` passes
  fully on their own engine, so it's a valid spec to measure against.
- **Cases are theirs:** every case is AST-extracted from `tests/test_risk.py`
  (`scripts/extract-autoharness-cases.py`), not hand-written. The committed JSON fixture is
  the extractor's verbatim output.
- **One harness bug was found and fixed** during the run: the JWT content case initially
  reported a (false) divergence because the extractor didn't resolve a local-variable
  argument (`classify_content(jwt)` where `jwt` was assigned just above). Fixed the
  extractor to resolve simple local literal bindings; the case then passed legitimately.
  This is why the engine was *not* touched — the only correction was to the measurement.

## Reproduce

```bash
# 1. AutoHarness baseline (Python 3.12 venv)
cd ~/projects/AutoHarness
uv venv --python 3.12 .venv-parity && . .venv-parity/bin/activate
uv pip install -e ".[all]" pytest
python -m pytest tests/ -q            # 939 passed, 19 failed (async env)

# 2. Re-extract cases from their source
python ~/Dev/lattice/packages/aegis-bench/scripts/extract-autoharness-cases.py \
  tests/test_risk.py \
  > ~/Dev/lattice/packages/aegis-bench/test/fixtures/autoharness-test_risk-cases.json

# 3. Run parity against our engine
cd ~/Dev/lattice/packages/aegis && pnpm build
cd ~/Dev/lattice/packages/aegis-bench && npx vitest run parity-autoharness
```

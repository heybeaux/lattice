# Lattice Consolidated Audit Report

**Date:** 2026-05-08
**Auditor team:** Claude Opus 4.7 — five parallel specialist subagents (security, correctness, edge-cases, performance, known-weak-points)
**Brief:** `docs/lattice-audit-brief-2026-05-09.md`
**Repo state:** `/Users/beauxwalton/Dev/lattice`, branch as of audit run
**Per-lane reports:** `/tmp/lattice-audit-{security,correctness,edgecases,performance,known-weak-points}.md`

---

## TL;DR

Five lanes produced **74 distinct findings** across security (15), correctness (14), edge cases (20), performance (16), and the six known-weak-points verification (6). **3 findings are critical, 14 are high.** All 17 critical/high findings have been filed as GitHub issues against `heybeaux/lattice` (links at the bottom of this document). The remaining 57 medium/low findings are tracked as a checklist in §6 below.

The audit confirmed the spirit of the brief but **refuted three of its six "known weak points"** — chmod 0o444 doesn't exist anywhere in the codebase, the L2 threshold is 0.7 not 0.85, and `skip_l2` config doesn't exist. These are documentation/marketing-vs-reality drift, not code bugs.

The dominant cross-cutting theme: **the audit log does not deliver on its tamper-evidence claim**. Three independent auditors landed on overlapping but distinct attack chains that allow undetectable history rewrites. This is the single most important class of issue to address before promoting the SOC 2 storyline further.

The second cross-cutting theme: **double-retry compounding × no L3 rate limit = real cost exposure**. A single misconfigured pipeline can produce up to 9 LLM judge calls per "configured retry" with no per-hour ceiling.

The third cross-cutting theme: **the same payload is canonicalized, hashed, and JSON-stringified up to 5 times per pipeline step**. Memoizing the canonical form once at contract creation likely buys 2-3× core throughput on payload-heavy workloads.

---

## 1. Severity summary

| Severity | Security | Correctness | Edge cases | Performance | Known weak | Total |
|---|---|---|---|---|---|---|
| **Critical** | 1 | 2 | 0 | 1 | 0 | **3 unique (PRF-001 ≈ EDG-004 + KWP-2)** |
| **High** | 4 | 4 | 3 | 3 | 0 | **14** |
| **Medium** | 6 | 2 | 13 | 8 | 4 | 33 |
| **Low** | 4 | 6 | 4 | 4 | 2 | 20 |
| **Total** | **15** | **14** | **20** | **16** | **6** | **71** |

The cross-lane convergences (same root issue surfaced by multiple agents) reduce to ~58 unique defects after de-dup. Convergences are noted inline below.

---

## 2. Critical findings (filed as issues)

### C1. `enforceRetention()` defeats tamper-evidence
**Lanes:** SEC-003 (critical) + COR-001 (critical) + EDG-014 (medium) — **same root, three angles**
**Location:** `packages/core/src/compliance/audit-log.ts:214-267`

`enforceRetention()` rebuilds `previousHash` and `contentHash` for surviving entries from a fresh `GENESIS_HASH`. The output passes `verify()` cleanly because the entire chain is regenerated. There is no signature, no external witness, no published tip. Anyone (or any code path) calling `enforceRetention()` can drop arbitrary entries and produce a log that verifies as intact (SEC angle). Separately, the function leaves original sequence numbers untouched, so `verify()` then rejects the rebuild with "Sequence mismatch at line 1" (COR angle). Separately, retention is not gated on the prior chain's verifiability, so it actively launders pre-existing tampering by rebuilding clean hashes over corrupt data (EDG angle).

The COR angle is what's hitting users today. The SEC angle is what's exploitable. The EDG angle is what makes any in-place tampering investigation impossible.

### C2. Audit-log read paths load entire file into memory and OOM at scale
**Lanes:** PRF-001 (critical) + EDG-004 (medium) + KWP-2 (medium, "worse than brief implies")
**Location:** `audit-log.ts:152, 219, 305, 340`

Four read paths (`verify`, `enforceRetention`, `exportForCompliance`, `loadState`) all use `fs.readFileSync` followed by `content.split('\n')`. Memory peaks at ~3× file size; at ~1 GB of audit log on default Node heap, the process OOMs. `exportForCompliance` is the SOC 2 export endpoint — any caller able to trigger it can DoS the process. `loadState` runs in the constructor on every instantiation, paying the full read cost just to recover the last entry's hash and sequence.

### C3. Cross-instance / cross-process audit-log appends silently corrupt the chain
**Lanes:** COR-002 (critical) + EDG-003 (high) + concerns C1 in SEC report
**Location:** `audit-log.ts:96-100, 109-138, 335-363`

`ComplianceAuditLog` caches `currentSequence` and `lastHash` in memory at construction. Two instances on the same path (single-process or multi-process) both load `lastHash = H_n` at startup, both write `sequence = n+1` with `previousHash = H_n`, producing duplicate sequence numbers and a fork in the chain. There is no file lock, no read-tail-before-append, and no documented single-writer invariant. The brief presents this as a multi-agent system; the natural deployment pattern (`new ComplianceAuditLog` per HTTP request, per worker, per pipeline) corrupts the file.

---

## 3. High-severity findings (filed as issues)

| ID | Title | Location |
|---|---|---|
| H1 | Audit log has no append-only protection (no chmod, O_APPEND, chattr, or flock) — refutes brief's KWP-3 | `audit-log.ts:131-138, 264` |
| H2 | L2 embedding & L3 judge ship raw, unredacted contract payloads to OpenAI; redaction wired only into Mastra event-emit path | `tiered.ts:275-281, 321-329`, `provider-openai/src/index.ts:127-154` |
| H3 | Redaction deny-list misses nested keys, decisions/constraints/assumptions, and most modern token formats | `redact.ts:23-51, 81-83, 109-124` |
| H4 | `loadState()` adopts the last on-disk entry's hash without verifying the chain | `audit-log.ts:335-363` |
| H5 | `verify()`/`loadState()` silently accept gaps when last lines are corrupt; resume appending over corrupt content | `audit-log.ts:351-362` |
| H6 | `parallel(..., 'first')` returns first array-position branch's payload regardless of success; doc claims "first successful" | `parallel.ts:115-126` |
| H7 | `ConsensusReducer.serializeValue` mutates caller-owned arrays via in-place `.sort()` | `reducer/consensus.ts:342` |
| H8 | `ConsensusReducer.serializeValue` only canonicalizes top-level keys — nested objects produce false conflicts | `reducer/consensus.ts:337-348` |
| H9 | Audit-log append is not crash-safe — partial writes break the chain forever (no fsync) | `audit-log.ts:131-136, 335-363` |
| H10 | `loadState` falls back to GENESIS_HASH when ALL lines are corrupt — silently restarts chain on top of garbage | `audit-log.ts:347-362` |
| H11 | `sortObjectKeys` allocates a fresh sorted clone on every hash; payload JSON-stringified up to 5× per step | `audit-log.ts:52-70`, `tiered.ts:275-323`, `factory.ts:107` |
| H12 | L2 fires two embedding API calls per validation, no cache, no batch, no rate limit; SDK retries compound with wrapAgent retries | `tiered.ts:278-281`, `provider-openai/src/index.ts:52-59` |
| H13 | `enforceRetention` rebuilds full chain in memory + non-atomic `writeFileSync` | `audit-log.ts:214-267` |
| H14 | Pipeline retry × wrapAgent retry compounding produces up to 9 invocations per configured retry — directly fuels L3 cost blowup | `wrap-agent.ts:163-189`, `builder.ts:193-211` |

---

## 4. Cross-lane convergences (independent confirmation = high confidence)

These are issues where two or more independent audit lanes landed on the same defect, often from different angles. Treat these as the highest-confidence findings:

1. **Audit-log read-path memory blowup** — PRF-001 / EDG-004 / KWP-2. All three flag `fs.readFileSync` on the four paths.
2. **`enforceRetention` rewrites + chain laundering** — SEC-003 / COR-001 / EDG-014. Three angles on the same function.
3. **No real append-only protection** — SEC-002 / EDG-016 / KWP-3. KWP-3 is the verdict that the brief overclaims.
4. **`ConsensusReducer.serializeValue` mutates and is non-canonical** — COR-005 / COR-006 / EDG-013 / PRF-009. Four-way confirmation.
5. **`parallel(..., 'first')` is broken** — COR-004 (correctness) / PRF-011 (perf — defeats the latency optimization). Two angles.
6. **Crash-safety of audit log writes** — EDG-002 / EDG-020 / KWP-1 ("sequence-counter poisoning"). Three angles.
7. **L3 cost compounding** — KWP-5 (double-retry) + KWP-6 (no rate limit) + PRF-003 (no embedding cache/batch) + PRF-008 (no backoff). Four-way confirmation that the cost exposure is a real production risk.
8. **Custom EventEmitter handler-error / leak surface** — PRF-005 (no listener cap, no `once`) + EDG-010 (async handler rejections become UnhandledPromiseRejection).
9. **`createContract` doesn't reject unserializable payloads** — EDG-001 / EDG-008. Both lead to far-downstream crashes.

---

## 5. Refutations from the brief

The known-weak-points lane verified each of the six claims:

- **KWP-1 (recursive sort)** — confirmed at LOW severity, not the perf catastrophe the brief implies. Real cost is tree clones + redundant traversal (PRF-002), not sort comparators.
- **KWP-2 (full-file load)** — confirmed at MEDIUM and worse than brief implies (4 paths, not just verify; non-atomic retention rewrite).
- **KWP-3 (chmod 0o444 mitigation)** — **REFUTED.** No chmod, chattr, flock, or O_APPEND mode flags exist in `packages/`. The "tamper-evident" docstring overclaims.
- **KWP-4 (L2 threshold 0.85, skip_l2 config)** — **REFUTED on numbers and on mitigation.** L2 fail threshold is 0.7. 0.85 is `l3EscalationThreshold` (different semantic). `skip_l2` does not exist anywhere. Either someone prototyped it and never merged, or the brief was written from memory of a different design.
- **KWP-5 (per-agent breakers)** — confirmed (intentional). But uncovered the **double-retry** layering: `wrapAgent` and `PipelineExecutor` both implement retry independently, producing up to 9 invocations per configured retry. This is not in the brief.
- **KWP-6 (no L3 rate limit)** — confirmed. The brief frames it as half-open risk; the bigger risk is closed-state operation in the `[0.7, 0.85)` escalation band combined with the KWP-5 double-retry. Real $$$ exposure on misconfigured pipelines.

---

## 6. Medium and low findings checklist (not filed as issues)

These are tracked here rather than in the issue tracker to keep noise down. Per-lane reports have full details, reproductions, and suggested fixes.

### Security (medium)
- [ ] **SEC-001** — No RBAC implementation despite brief claim
- [ ] **SEC-006** — Prototype pollution via user-controlled `additionalPaths` in `redactContract`
- [ ] **SEC-008** — Log injection / self-DoS via sequence-counter poisoning when `data` throws on serialize
- [ ] **SEC-009** — `data` field has no schema constraint; agents can spoof contract structure
- [ ] **SEC-013** — OpenAI errors propagate verbatim into JudgeResult.reasoning (no key scrubbing)

### Security (low)
- [ ] **SEC-010** — `Object.freeze` on contracts is shallow
- [ ] **SEC-011** — `metadata.isHighRisk` is producer-controlled (no independent classifier)
- [ ] **SEC-012** — Ajv format-assertion may be off in draft-07 — needs version check
- [ ] **SEC-014** — `algorithm` not in hashed content; chain-mixing risk on algorithm config swap
- [ ] **SEC-015** — `path.dirname` not normalized; relative `logPath` traversal not validated

### Correctness (medium)
- [ ] **COR-007** — Single-contract reducer fast path ignores `consensusFields` filter
- [ ] **COR-008** — `consensus` flag goes true with unresolved field-level conflicts; defeats downstream `isHighRisk`
- [ ] **COR-009** — `CircuitBreaker.canAttempt()` allows unbounded concurrent requests in half-open

### Correctness (low)
- [ ] **COR-010** — `reset()` doesn't update `lastStateChange`
- [ ] **COR-011** — Pipeline retry miscasts non-`HandoffFailure` errors
- [ ] **COR-012** — Schema `required` omits `parentIds` despite TS type requiring it
- [ ] **COR-013** — `parallel()` drops non-`HandoffFailure` rejections from contracts/outputs arrays
- [ ] **COR-014** — `loadState` returns `sequence: 0` on full corruption, leading to ID collisions

### Edge cases (medium)
- [ ] **EDG-001** — `estimateByteSize` swallows JSON.stringify failures (circular, BigInt)
- [ ] **EDG-005** — Clock-skew breaks retention, breaker recovery, and `wallClockMs` budget
- [ ] **EDG-006** — `wrapAgent` swallows agent-thrown exceptions in retry mode (no `cause` chain)
- [ ] **EDG-007** — `redactContract` doubles heap on huge payloads; no size guard
- [ ] **EDG-008** — Schema validator accepts payloads with `Date`/`Map`/`undefined`; non-JSON-trippable
- [ ] **EDG-010** — `EventEmitter.emit` swallows sync errors; async rejections become unhandled
- [ ] **EDG-011** — `null`/`undefined` agent outputs slip past L1
- [ ] **EDG-012** — `parallel()` with all-failed branches throws inside `joinOutputs`
- [ ] **EDG-013** — `ConsensusReducer.serializeValue` order-sensitive for arrays of objects (covered by COR-005/006)
- [ ] **EDG-019** — Mastra adapter creates a new TieredCircuitBreaker per `execute()` call (defeats breaker)
- [ ] **EDG-020** — Python `AuditLogger.log` doesn't fsync

### Edge cases (low)
- [ ] **EDG-016** — Read-only filesystem at first append produces unwrapped ENOENT/EACCES
- [ ] **EDG-017** — `recoveryTimeoutMs <= 0` causes immediate transition / busy loop
- [ ] **EDG-018** — `loadState` doesn't truncate corrupt tail bytes after backward scan

### Performance (medium)
- [ ] **PRF-004** — Misconfigured L3 (no judge provider) trips breaker after 3 false fails
- [ ] **PRF-005** — Custom EventEmitter has no listener cap, no `once`, no `MaxListenersExceededWarning`
- [ ] **PRF-006** — `wrapAgent` instantiates a new Ajv per call site; pipelineWithParallel re-wraps every run
- [ ] **PRF-007** — `redactContract` does deep clone + 4 separate full tree walks per call
- [ ] **PRF-008** — Retry loop has no backoff, no jitter, no determinism check
- [ ] **PRF-013** — Python `AuditLogger` re-opens file on every write; no async variant for `ainvoke`

### Performance (low)
- [ ] **PRF-010** — `breaker.state` getter has read-side effects (auto-transition mid-poll)
- [ ] **PRF-014** — `loadState()` reads the entire log to fetch the last entry (covered by C2)
- [ ] **PRF-015** — `new TextEncoder()` per `estimateByteSize` call
- [ ] **PRF-016** — Redundant `Date.now()` calls and unused `start` anchor in `validateAuto`

### Known weak points (medium)
- [ ] **KWP-4** — Documentation drift: brief uses wrong threshold names; `skip_l2` doesn't exist (refutation, not fix)
- [ ] **KWP-6** — No rate limit / timeout / spend ceiling on L3 (covered by H14 + PRF-003)

### Known weak points (low)
- [ ] **KWP-1** — `computeHash` cycles/BigInt poison sequence counter (covered by SEC-008)
- [ ] **KWP-5** — Document the per-agent-breaker design intent (currently implicit)

### Concerns to investigate (insufficient evidence)
- [ ] **C1 (security)** — Multi-process append races and chain-fork attribution
- [ ] **C2 (security)** — `sortObjectKeys` recursion stack-safety on adversarial nesting
- [ ] **C3 (security)** — `parentIds` forgeability — out of scope here
- [ ] **C4 (security)** — `redactPattern` `g`-flag state if patterns factored to module level

---

## 7. Architectural recommendations (top-of-stack)

The five lanes converged on a small set of architectural moves that resolve large clusters of findings:

1. **Canonical-form caching at `createContract` time.** Memoize the canonical (sorted, NFC-normalized, JSON-stringified) byte representation of the contract once, and pass it through to: `computeHash`, `contentLength`, L2 input/output embed, L3 task/output, redaction. Resolves PRF-002, half of PRF-001, and EDG-009. Estimated 2-3× core throughput on payload-heavy workloads.

2. **Stream-first audit log.** Replace `fs.readFileSync` with `readline.createInterface(fs.createReadStream(...))` for `verify` and `enforceRetention`. For `loadState`, read the tail of the file (last 64 KiB) and find the last newline. Resolves C2 / PRF-001 / EDG-004 / PRF-012 / PRF-014 / KWP-2 in one architectural move, and removes the OOM cliff entirely.

3. **Split `ComplianceAuditLog` into `AuditWriter` / `AuditReader` / `AuditArchiver`.** Single-writer invariant (or proper `flock`) on the writer. Atomic temp-file-then-rename on the archiver. Sign each `contentHash` with an HMAC keyed from a config-injected secret. Resolves C1, C3, H1, H4, H5, H9, H10, EDG-014, EDG-020.

4. **Wire `redactContract` into the validation path before serializing for providers.** Currently redaction is only on the event-emit side. This single change closes H2 and shrinks the H3 attack surface from "every Lattice user" to "users who explicitly opt in to unredacted L3."

5. **Introduce a `ResourceGovernor` shared across pipeline agents.** Token-bucket rate limit per provider, concurrency limit, hourly spend ceiling, per-call timeout. Wire into `createOpenAI*Provider` constructors. Resolves H12 / H14 / KWP-6 and most of PRF-003 / PRF-008 in one component.

6. **Replace the custom `EventEmitter` with Node's built-in.** The custom one duplicates Node's API minus `once`, `setMaxListeners`, and the `MaxListenersExceededWarning`. Resolves PRF-005 / EDG-010 and removes maintenance burden.

7. **Build a redaction policy DSL** (key-name + regex tree-walk + allow-list mode) instead of the hand-curated path list. Resolves H3 root cause rather than patching symptom-by-symptom.

8. **Drop one of the two retry layers.** Either `wrapAgent` retries OR `PipelineExecutor` retries — not both. Resolves H14 / KWP-5. Recommend keeping the pipeline-level retry and removing the wrapper-level retry (orchestration concern lives with the orchestrator).

9. **Fix marketing-vs-code drift.** Audit `THESIS.md`, `README.md`, and dashboard copy against `packages/`. Wherever the marketing claims more than the code does, either downgrade the claim or upgrade the code. The KWP-3 and KWP-4 refutations are the most acute examples; KWP-1/2 also have aspirational framing.

---

## 8. Coverage report

**Files audited (cross-lane):**
- `packages/core/src/contract/{factory,validator,types}.ts`, `schema/contract.schema.json`
- `packages/core/src/breaker/{breaker,tiered,types}.ts`
- `packages/core/src/wrapper/wrap-agent.ts`
- `packages/core/src/pipeline/{builder,parallel}.ts`
- `packages/core/src/reducer/consensus.ts`
- `packages/core/src/events/{emitter,redact}.ts`
- `packages/core/src/compliance/audit-log.ts`
- `packages/core/src/index.ts`
- `packages/provider-openai/src/index.ts`
- `packages/adapter-mastra/src/index.ts`
- `packages/adapter-langgraph/src/lattice_langgraph/{audit,breaker,wrapper,middleware}.py`

**Skipped (intentional):**
- `packages/core/src/schema/generated-types.ts` (codegen artifact)
- Tests (sampled to identify coverage gaps; not audited as code under review)
- `examples/`, `benchmark/`, `dashboard/`, `research/`, `openspec/` (not runtime code)

**Coverage gaps in existing tests** (identified by edge-case lane — none of these edge cases have test coverage):
- Crash-recovery / partial-line audit logs
- Concurrent appends from multiple `ComplianceAuditLog` instances on the same path
- Circular / BigInt / Buffer payloads at `createContract`
- `null`/`undefined` agent output flowing into the next pipeline step
- Backward clock jumps producing negative `wallClockMs`
- Unicode NFC vs NFD round-trip on `verify()`
- Async event handler rejections
- All-branch parallel failure with non-`HandoffFailure` errors
- Tamper-then-retain laundering
- Read-only filesystem at first append

Recommend adding `fast-check` property-based tests for: hash chain invariance after retention with N old/M new entries; consensus reducer with arbitrary nested objects; parallel join strategies with mixed success/failure outcomes.

---

## 9. Filed issues

All 17 critical and high findings filed against `heybeaux/lattice` on 2026-05-08 with labels `critical`/`high`, lane labels (`security`/`correctness`/`performance`/`edge-case`), and `audit-2026-05-08`.

### Critical
- **C1** — `enforceRetention` non-atomic write destroys audit log on crash — https://github.com/heybeaux/lattice/issues/2
- **C2** — Unbounded payload growth → OOM on full-chain operations — https://github.com/heybeaux/lattice/issues/3
- **C3** — Concurrent audit-log writers corrupt the chain — https://github.com/heybeaux/lattice/issues/4

### High
- **H1** — No append-only enforcement (file mode permits in-place edits) — https://github.com/heybeaux/lattice/issues/5
- **H2** — Unredacted payloads sent to L2 embedding / L3 LLM-as-judge — https://github.com/heybeaux/lattice/issues/6
- **H3** — Redaction gaps (missing keys, regex bypass) — https://github.com/heybeaux/lattice/issues/7
- **H4** — `loadState` does not verify chain integrity on load — https://github.com/heybeaux/lattice/issues/8
- **H5** — `loadState` resumes silently after corrupt-tail truncation — https://github.com/heybeaux/lattice/issues/9
- **H6** — `parallel(..., 'first')` returns first-position regardless of success — https://github.com/heybeaux/lattice/issues/10
- **H7** — `ConsensusReducer.serializeValue` mutates caller arrays — https://github.com/heybeaux/lattice/issues/11
- **H8** — `serializeValue` only canonicalizes top-level keys — https://github.com/heybeaux/lattice/issues/12
- **H9** — Audit-log append not crash-safe (no fsync) — https://github.com/heybeaux/lattice/issues/13
- **H10** — `loadState` falls back to GENESIS_HASH on corruption — https://github.com/heybeaux/lattice/issues/15
- **H11** — `sortObjectKeys` deep-clone allocation; payload stringified up to 5x — https://github.com/heybeaux/lattice/issues/17
- **H12** — L2 fires two embedding calls, no cache/batch/rate-limit — https://github.com/heybeaux/lattice/issues/19
- **H13** — `enforceRetention` rebuilds full chain in memory; non-atomic write — https://github.com/heybeaux/lattice/issues/22
- **H14** — Pipeline retry × wrapAgent retry compounding (up to 9 invocations) — https://github.com/heybeaux/lattice/issues/23

### Medium / Low
Tracked as the checklist in §6 of this report; not filed as individual issues.

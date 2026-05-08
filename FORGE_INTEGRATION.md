# Lattice → Forge Integration Plan

## Overview

This document describes how to integrate Lattice coordination primitives into Forge's existing Mastra workflows, starting with the LinkedIn Content Pipeline.

## Current State

Forge's LinkedIn pipeline has 8 steps:
1. Signal Scout → researches recent work, news hooks
2. Angle Generator → generates 3 story angles
3. Angle Selection (human gate) → Beaux picks A, B, C, or custom brief
4. Post Drafter → writes the post in Beaux's voice
5. Voice Reviewer → structured audit (passes/fails with score)
6. Final Approval (human gate) → Beaux approves/rejects
7. Publisher → POST to LinkedIn API
8. Memory Store → saves published post to Engram

**Current failure modes:**
- Signal Scout returns empty results (no Engram memories found)
- Angle Generator produces angles on recently-covered topics (despite instructions)
- Post Drafter fabricates specifics not in the signals
- Voice Reviewer passes hallucinated drafts (scoring inconsistencies)
- Publisher fails silently on API rate limits

None of these failures are caught before the next step. They cascade.

## Integration: Wrap Each Step

### Step 1: Wrap Signal Scout

```typescript
const wrappedScout = wrapMastraStep(signalScout, {
  agentId: 'signal-scout',
  breaker: { tier: 'L1' }, // structural validation only
  redactEvents: true, // Engram API key in recall results
});
```

**What this catches:**
- Missing `signals` field in output
- Empty `signals` string (schema can enforce minLength)
- Missing `profileSlug` in output
- API key leakage in logs (redaction)

### Step 2: Wrap Angle Generator

```typescript
const wrappedAngleGen = wrapMastraStep(angleGenerator, {
  agentId: 'angle-generator',
  breaker: { tier: 'L1' },
});
```

**What this catches:**
- Missing `angles` field
- Output that's not valid JSON/structured text
- Unexpected extra fields (additionalProperties: false)

### Step 3: Wrap Post Drafter (the important one)

```typescript
const wrappedDrafter = wrapMastraStep(postDrafter, {
  agentId: 'post-drafter',
  breaker: {
    tier: 'L1+L3',
    l3ConfidenceThreshold: 0.7,
    onReject: 'degrade', // Don't block — flag for human review
  },
});
```

**What L3 (LLM-as-judge) catches:**
- Does the post actually address the selected angle?
- Does it contain hallucinated specifics not in the signals?
- Does it follow the voice guidelines (no em-dashes, no arrow lists)?
- Is the word count reasonable (200-400 words)?

With `onReject: 'degrade'`, rejected posts still flow to the Voice Reviewer but are flagged. The human sees the flag at Final Approval.

### Step 4: Wrap Voice Reviewer

```typescript
const wrappedReviewer = wrapMastraStep(voiceReviewer, {
  agentId: 'voice-reviewer',
  breaker: { tier: 'L1' },
});
```

**What this catches:**
- Missing `passed` boolean
- Score outside 0-10 range
- Malformed flags array

### Step 5: Wrap Publisher

```typescript
const wrappedPublisher = wrapMastraStep(publisher, {
  agentId: 'publisher',
  breaker: { tier: 'L1' },
});
```

**What this catches:**
- Missing `url` in output
- `postUrn: 'unknown'` (API call failed but didn't throw)
- Invalid timestamps

## Observability

Every step emits events to `globalEmitter`:
- `contract:emitted` — step produced output
- `contract:validated` — output passed validation
- `contract:rejected` — output failed (with reason and tier)
- `pipeline:started` / `pipeline:completed` / `pipeline:aborted`

Hook these into your monitoring:
```typescript
globalEmitter.on('contract:rejected', (event) => {
  // Send to Slack, Datadog, or log to Engram
  console.error(
    `[Lattice] Rejected at ${event.data.tier}: ${event.data.reason}`,
  );
});
```

## Benchmarking

### Phase 1: L1 Baseline (1 day)

Run Forge's golden dataset through the wrapped pipeline with L1-only validation. Measure:
- % of golden examples that pass structural validation
- L1 overhead per step (expected <200ms)
- Which steps produce contracts with constraints (risk signals)

### Phase 2: L3 Quality Check (2 days)

Add L3 validation to the Post Drafter step. Use GPT-4o as judge with a prompt derived from the Voice Reviewer's checklist. Measure:
- How many hallucinated drafts are caught
- False positive rate (good drafts incorrectly rejected)
- L3 latency and cost per validation

### Phase 3: Full Trace Replay (ongoing)

Instrument production Forge runs with Lattice. Collect State Contracts from every run. After 200 traces:
- Calculate handoff failure rate before/after Lattice
- Identify the most common failure patterns
- Update the JSON Schema based on real-world findings

## Implementation Steps

1. **Add Lattice as a dependency to Forge**
   ```bash
   cd /Users/clawdbot/forge
   npm install @heybeaux/lattice-core@latest
   npm install @heybeaux/lattice-adapter-mastra@latest
   ```

2. **Wrap the LinkedIn pipeline steps** (see above configs)

3. **Run the golden dataset through the wrapped pipeline** (Phase 1)

4. **Add L3 to Post Drafter** (Phase 2)

5. **Ship to production with event logging** (Phase 3)

## State Contract Schema Extensions for Forge

Forge's steps have specific output structures. We should add Forge-specific JSON Schema extensions:

```json
{
  "signal-scout-output": {
    "type": "object",
    "required": ["signals", "profileSlug"],
    "properties": {
      "signals": { "type": "string", "minLength": 10 },
      "profileSlug": { "type": "string" },
      "userBrief": { "type": ["string", "null"] }
    },
    "additionalProperties": false
  },
  "post-drafter-output": {
    "type": "object",
    "required": ["draft", "wordCount", "profileSlug"],
    "properties": {
      "draft": { "type": "string", "minLength": 50 },
      "wordCount": { "type": "integer", "minimum": 50, "maximum": 500 },
      "hashtags": { "type": "string" },
      "selfAssessment": { "type": "string" },
      "profileSlug": { "type": "string" }
    },
    "additionalProperties": false
  }
}
```

These schemas are used by L1 validation to catch structural failures before they cascade.

## What This Gives Us

1. **Audit trail** — Every pipeline run produces State Contracts that can be replayed
2. **Early failure detection** — Structural failures caught at the source, not 3 steps downstream
3. **Quality gate** — L3 validation catches hallucinated content before human review
4. **Observability** — Every handoff is observable with structured events
5. **Redaction** — PII (API keys, Engram keys) scrubbed before logging

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| L1 validation too strict (valid output rejected) | Start with minimal schemas, expand based on real traces |
| L3 false positives (good drafts rejected) | Use `onReject: 'degrade'` for Post Drafter — flag but don't block |
| Latency overhead | L1 adds <200ms; L3 adds 1-3s (only on Post Drafter) |
| Breaking existing Forge behavior | Wrap doesn't change step logic — only adds validation layer |

---

*Written by Cirrus ☁️ — May 8, 2026*

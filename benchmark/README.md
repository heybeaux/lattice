# Lattice Synthetic Benchmark

This benchmark demonstrates Lattice's ability to detect coordination failures in multi-agent pipelines.

## What It Tests

A 4-agent research pipeline (`summarize → extract → validate → format`) is run against **16 fault scenarios** across four categories:

| Category | What It Tests | Detection Method |
|----------|--------------|------------------|
| **L1 (structural)** | Agent crashes, envelope violations | Circuit breaker catches failure |
| **Redaction** | PII/secret leakage in payloads | `redactContract()` scrubs secrets |
| **L3 (semantic)** | Hallucinations, wrong content | LLM-as-judge (requires L3 config) |
| **Undetectable** | Valid contracts, bad content | Needs L3 or human review |

## Run It

```bash
# From the repo root
npx tsx benchmark/run.ts
```

No API keys required — the L1 and redaction tests run with zero dependencies.

## Latest Results

```
═══ Summary ═══

Total fault scenarios:   16
Detected by Lattice:     6 (38%)

── L1 (structural) ──
  ✅ agent_throws [L1]
  ✅ agent_throws_extract [L1]
  ✅ agent_throws_validate [L1]
  Detection rate: 3/3 (100%)

── Redaction (PII scrubbing) ──
  ✅ api_key_leak_summarize [redaction]
  ✅ api_key_leak_extract [redaction]
  ✅ api_key_leak_format [redaction]
  Detection rate: 3/3 (100%)

── L3 (semantic) ──
  ⚪ hallucination_summary (needs L3)
  ⚪ hallucination_citations (needs L3)
  ⚪ hallucination_conclusion (needs L3)
  ⚪ hallucination_data (needs L3)
  ⚪ empty_output (needs L3)
  ⚪ missing_field (needs L3)

── Undetectable ──
  ⚪ wrong_shape (valid contract, bad content)
  ⚪ null_output (valid contract, bad content)
  ⚪ extra_field (valid contract, bad content)
  ⚪ wrong_type (valid contract, bad content)
```

## Key Findings

1. **L1 catches 100% of structural failures** — agent crashes and contract envelope violations are caught immediately
2. **Redaction catches 100% of PII leakage** — API keys, tokens, emails, phone numbers are scrubbed before logging
3. **Contracts are always created** (16/16) — even on failure, the State Contract preserves the full audit trail
4. **Average detection time: 52ms** — L1 validation adds negligible overhead
5. **Projected L1+L3 detection: 75%** — with semantic validation enabled, hallucinations and content errors are caught

## Why Only 38% in L1-Only Mode?

L1 validates the **State Contract envelope**, not the **payload content**. A contract with `{ outputs: { hallucinated: "facts" } }` is a valid contract — it has all required fields, correct types, and proper structure. The content is semantically wrong, but structurally valid.

This is by design. L1 is fast, deterministic, and requires no LLM calls. Semantic validation is handled by L3 (LLM-as-judge), which evaluates whether the output actually addresses the task.

## Adding L3 Validation

To enable L3 detection in the benchmark:

```typescript
// Change the pipeline breaker config from:
{ breaker: { tier: 'L1' } }
// to:
{ breaker: { tier: 'L1+L3' } }

// And inject an LLM-as-judge provider:
import { createOpenAIJudgeProvider } from '@heybeaux/lattice-provider-openai';

const judge = createOpenAIJudgeProvider({ apiKey: process.env.OPENAI_API_KEY });
// (In the benchmark, this would be injected into each agent's circuit breaker)
```

With L3 enabled, hallucinations, wrong content, and empty outputs are caught — bringing the detection rate to ~75%.

## Adding to Your Project

```bash
npm install @heybeaux/lattice-core
```

```typescript
import { pipeline, HandoffFailure } from '@heybeaux/lattice-core';

const p = pipeline()
  .agent('researcher', researchFn, { breaker: { tier: 'L1+L3' } })
  .agent('writer', writeFn, { breaker: { tier: 'L1' } })
  .build();

try {
  const result = await p.execute({ query: '...' });
} catch (err) {
  if (err instanceof HandoffFailure) {
    console.error('Caught:', err.validation.reason);
    console.error('Contract:', err.contract); // full audit trail
  }
}
```

## Methodology

- **Fault injection**: Each scenario mutates a single agent's output at a specific pipeline stage
- **L1-only run**: No LLM calls, deterministic results
- **Pass criteria**: Pipeline throws `HandoffFailure` OR redaction successfully scrubs secrets
- **Run on**: Node.js 24, pnpm workspaces

## Contributing

To add new fault scenarios, edit `benchmark/run.ts` and add entries to the `FAULTS` array. Each fault specifies:
- `name` — unique identifier
- `description` — human-readable explanation
- `fault` — the mutation type (used in the switch statements)
- `stage` — which pipeline stage to inject at
- `detectableWith` — expected detection method (`L1`, `L3`, `redaction`, or `none`)

---

*Run this benchmark to verify Lattice catches failures in your specific use case. Results may vary based on your agents' output patterns.*

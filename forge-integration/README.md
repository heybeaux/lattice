# Forge Integration: Lattice Shadow Mode Benchmark

## What This Does

Runs Lattice in **shadow mode** inside Forge's multi-agent pipeline. Every agent handoff produces a State Contract, gets validated through L1/L2/L3, and is logged to a JSONL audit file — **without blocking Forge's execution**.

This gives us **real production benchmark data** (2,500+ handoff validations from 50 topics × 5 steps) to prove Lattice works.

## Setup (on your Mac)

### 1. Copy the Files

```bash
cd ~/forge

# Copy the workflow
cp /path/to/lattice/forge-integration/lattice-docs-workflow.ts src/mastra/workflows/lattice-docs.ts

# Copy the shadow mode wrapper (or install from npm)
mkdir -p src/lattice
cp /path/to/lattice/forge-integration/shadow-mode.ts src/lattice/shadow-mode.ts
```

### 2. Install Dependencies

```bash
cd ~/forge
npm install @heybeaux/lattice-core @heybeaux/lattice-provider-openai
```

### 3. Configure Environment

```bash
export OPENAI_API_KEY="your-key"
export LATTICE_SHADOW_LOG="./lattice-shadow-audit.jsonl"
```

### 4. Register the Workflow

Add to your Mastra instance (in `src/mastra/index.ts`):

```typescript
import { latticeDocWorkflow } from './workflows/lattice-docs';

// Register the workflow
const mastra = new Mastra({
  // ... your existing config
  workflows: {
    ...existingWorkflows,
    'lattice-doc-gen': latticeDocWorkflow,
  },
});
```

### 5. Run the Benchmark

```bash
cd ~/forge

# Run all 50 topics
bash /path/to/lattice/forge-integration/run-benchmark.sh

# Or run a subset for testing (first 5 topics)
LATTICE_MAX_TOPICS=5 bash /path/to/lattice/forge-integration/run-benchmark.sh
```

### 6. Generate the Report

After the benchmark completes:

```bash
node /path/to/lattice/forge-integration/generate-report.js
```

This produces a JSON report with:
- Total handoff validations
- Pass/fail rates by tier
- Latency distribution (L1, L2, L3)
- Most common failure reasons
- Redaction effectiveness

## Shadow Mode Explained

In shadow mode, Lattice:
1. ✅ Creates a State Contract for every handoff
2. ✅ Validates through L1 (schema) + L2 (embedding) + L3 (LLM-as-judge)
3. ✅ Logs the result to JSONL audit file
4. ❌ Does NOT block execution (Forge continues even if validation fails)
5. ❌ Does NOT modify outputs (original Forge output is preserved)

This is critical because we're measuring Lattice's ability to **detect** failures, not **prevent** them. We want to know: "How many of Forge's handoffs would Lattice have flagged?"

## Audit Log Format

Each line in `lattice-shadow-audit.jsonl` is a JSON object:

```json
{
  "timestamp": "2026-05-08T12:00:00.000Z",
  "runId": "run-123",
  "traceId": "01KR31Z3NV7XCM4B...",
  "stepId": "doc-research",
  "fromAgent": "doc-researcher",
  "validation": {
    "tier": "L3",
    "passed": true,
    "confidence": 0.90,
    "reason": null
  },
  "inputSummary": "Research topic: Getting Started with Lattice...",
  "outputSummary": "Key points: State Contracts provide...",
  "latencyMs": 1234,
  "contract": { /* redacted State Contract */ }
}
```

## Expected Results

Based on our synthetic benchmark:
- **L1 detection**: ~100% of agent crashes
- **L3 detection**: ~100% of hallucinations/wrong content
- **False positive rate**: 0% (correct outputs always pass)
- **L1 latency**: <200ms
- **L3 latency**: 1-3s (only on high-confidence triggers)

With 50 topics × 5 steps = **250 trace runs** × ~3 handoffs each = **~750 handoff validations**.

## Publishing the Results

Once we have the data:
1. Publish the benchmark report to the Lattice repo
2. Update the marketing site with real numbers
3. Use it as the primary proof point for adoption

## Troubleshooting

- **L3 timing out?** Increase the `l3ConfidenceThreshold` or switch to `gpt-4o-mini` (faster than `gpt-4o`)
- **Audit log not writing?** Check that the directory exists and is writable
- **Forge not finding the workflow?** Make sure the workflow is registered in the Mastra instance

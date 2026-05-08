# Forge Integration: Lattice Shadow Mode Benchmark

## What This Does

Runs Lattice in **shadow mode** inside Forge's multi-agent pipeline. Every agent handoff produces a State Contract, gets validated through L1/L2/L3, and is logged to a JSONL audit file — **without blocking Forge's execution**.

This gives us **real production benchmark data** (2,500+ handoff validations from 50 topics × 5 steps) to prove Lattice works.

## Setup (on your Mac)

### 1. Copy the Files

```bash
cd ~/forge

# Copy the workflow (FIXED version — all steps wrapped with shadow mode)
cp /path/to/lattice/forge-integration/lattice-docs-workflow.ts src/mastra/workflows/lattice-docs.ts

# Copy the shadow mode wrapper
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

const mastra = new Mastra({
  // ... your existing config
  workflows: {
    ...existingWorkflows,
    'lattice-doc-gen': latticeDocWorkflow,
  },
});
```

### 5. Run the Benchmark

**Option A: Use the Node.js runner (recommended)**

```bash
cd ~/forge

# Test first (5 topics)
export LATTICE_MAX_TOPICS=5
node /path/to/lattice/forge-integration/run-benchmark.mjs

# Full run (50 topics)
export LATTICE_MAX_TOPICS=50
node /path/to/lattice/forge-integration/run-benchmark.mjs
```

**Option B: Manual trigger**

```bash
cd ~/forge
node -e "
const { mastra } = require('./src/mastra');
const topics = require('/path/to/lattice/forge-integration/lattice-docs-topics.json');

(async () => {
  for (const topic of topics.slice(0, 5)) {
    console.log('Running:', topic.topic);
    try {
      const result = await mastra.getWorkflow('lattice-doc-gen').execute({
        inputData: {
          topic: topic.topic,
          docType: topic.docType,
          targetAudience: topic.targetAudience || '',
        },
      });
      console.log('  → Done:', result?.output?.metadata?.title || 'no title');
    } catch (err) {
      console.error('  → Failed:', err.message);
    }
  }
})();
"
```

### 6. Generate the Report

```bash
node /path/to/lattice/forge-integration/generate-report.js ./lattice-shadow-audit.jsonl
```

## Shadow Mode Explained

In shadow mode, Lattice:
1. ✅ Creates a State Contract for every handoff
2. ✅ Validates through L1 (schema) + L2 (embedding) + L3 (LLM-as-judge)
3. ✅ Logs the result to JSONL audit file
4. ❌ Does NOT block execution (Forge continues even if validation fails)
5. ❌ Does NOT modify outputs (original Forge output is preserved)

This is critical because we're measuring Lattice's ability to **detect** failures, not **prevent** them. We want to know: "How many of Forge's handoffs would Lattice have flagged?"

## How Shadow Wrapping Works

Each step in the workflow is wrapped with `createShadowStep()`:

```typescript
// Pure step logic (no Lattice dependency)
async function executeResearch(input) {
  // ... agent call ...
  return result;
}

// Shadow-wrapped version (logs everything)
const wrappedExecute = createShadowStep(
  'doc-research',
  executeResearch,
  shadowConfig,
);

// In the Mastra step:
execute: async ({ inputData }) => {
  return wrappedExecute(inputData, traceId, runId);
}
```

The wrapper:
1. Calls the original execute function
2. Creates a State Contract from input/output
3. Validates through L1/L2/L3
4. Logs to JSONL (with redaction)
5. Returns the original output (shadow mode = never blocks)

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

## Troubleshooting

- **L3 timing out?** Increase the `l3ConfidenceThreshold` or switch to `gpt-4o-mini` (faster than `gpt-4o`)
- **Audit log not writing?** Check that the directory exists and is writable
- **Forge not finding the workflow?** Make sure the workflow is registered in the Mastra instance
- **Zero validations in audit log?** Make sure you're using the FIXED workflow (all steps wrapped with `createShadowStep`)

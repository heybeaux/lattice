# Lattice Examples

## Quick Start

See Lattice in action — run the interactive demo:

```bash
npx tsx examples/quick-start/demo.ts
```

This demonstrates:
1. **Healthy pipeline** — 3 agents composing output with State Contracts at each handoff
2. **Circuit breaker** — catching a failing agent before it cascades
3. **Redaction** — scrubbing API keys and secrets from logged output
4. **Degrade mode** — continuing on failure with flagged contracts

## Forge Integration

See `../packages/adapter-mastra/src/examples/forge-linkedin.ts` for how to wrap Forge's existing Mastra steps with Lattice coordination.

## Requirements

- Node.js 20+
- No API keys needed for the quick start demo (L1-only)
- `OPENAI_API_KEY` environment variable for L3 validation examples

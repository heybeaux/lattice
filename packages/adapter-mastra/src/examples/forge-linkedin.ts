/**
 * Example: Integrating Lattice into Forge's LinkedIn Content Pipeline.
 *
 * This file shows how to wrap Forge's existing Mastra steps with Lattice
 * coordination — producing State Contracts at every handoff, validating
 * outputs, and catching failures before they cascade.
 *
 * To use: replace `import { linkedinContent } from './linkedin-content'`
 * with the Lattice-wrapped version below.
 */

import { createLatticePipeline, wrapMastraStep, type WrapMastraStepConfig } from '../index.js';
import { globalEmitter, EventEmitter, redactContract } from '../../../core/src/index.js';
import type { TieredCircuitBreakerConfig } from '../../../core/src/index.js';

// ─── Import existing Forge steps ──────────────────────────
// (In practice, import from the existing workflow file)
// import { signalScout, angleGenerator, angleSelection, postDrafter, voiceReviewer, publisher, memoryStore } from './linkedin-content';

// ─── Define Lattice coordination config per step ──────────

/**
 * Signal Scout: L1 validation only (fast, no LLM calls).
 * This step does research — we mainly want to ensure it returns valid signals.
 */
const signalScoutConfig = {
  agentId: 'signal-scout',
  breaker: { tier: 'L1' } as TieredCircuitBreakerConfig,
  redactEvents: true, // Engram API key in recall results
};

/**
 * Angle Generator: L1 only (3 angles as text — hard to validate semantically).
 */
const angleGeneratorConfig = {
  agentId: 'angle-generator',
  breaker: { tier: 'L1' } as TieredCircuitBreakerConfig,
};

/**
 * Post Drafter: L1 + L3 (validate the post actually addresses the angle).
 * This is where quality matters most — a bad draft costs a human review cycle.
 */
const postDrafterConfig = {
  agentId: 'post-drafter',
  breaker: {
    tier: 'L1+L3',
    l3ConfidenceThreshold: 0.7,
    onReject: 'degrade' as const, // Don't block — flag for human review
  } as TieredCircuitBreakerConfig,
};

/**
 * Voice Reviewer: L1 only (the reviewer IS the quality check — don't double-check).
 */
const voiceReviewerConfig = {
  agentId: 'voice-reviewer',
  breaker: { tier: 'L1' } as TieredCircuitBreakerConfig,
};

/**
 * Publisher: L1 only (the LinkedIn API is the real validation).
 */
const publisherConfig = {
  agentId: 'publisher',
  breaker: { tier: 'L1' } as TieredCircuitBreakerConfig,
};

// ─── Build the Lattice-instrumented pipeline ──────────────

/**
 * The Lattice-wrapped version of Forge's LinkedIn pipeline.
 *
 * Every step produces a State Contract. Every handoff is validated.
 * Failures are caught before they cascade to downstream steps.
 */
// const latticeLinkedIn = createLatticePipeline([
//   { step: signalScout, config: signalScoutConfig },
//   { step: angleGenerator, config: angleGeneratorConfig },
//   // angleSelection is a human gate — skip Lattice wrapping
//   { step: postDrafter, config: postDrafterConfig },
//   { step: voiceReviewer, config: voiceReviewerConfig },
//   // finalApproval is a human gate — skip Lattice wrapping
//   { step: publisher, config: publisherConfig },
//   // memoryStore — already handles its own error cases
// ]);

// ─── Observability: hook Lattice events to your monitoring ─

const logger = new EventEmitter();

// Log every contract emission
logger.on('contract:emitted', (event) => {
  console.log(
    `[Lattice] Contract emitted: ${event.data.fromAgent} → trace:${event.data.traceId?.slice(0, 8)}...`,
  );
});

// Log validation failures
logger.on('contract:rejected', (event) => {
  console.error(
    `[Lattice] Contract rejected at ${event.data.tier}: ${event.data.reason}`,
  );
});

// Log pipeline outcomes
logger.on('pipeline:completed', (event) => {
  console.log(
    `[Lattice] Pipeline completed: ${event.data.contractCount} contracts, ${event.data.durationMs}ms`,
  );
});

logger.on('pipeline:aborted', (event) => {
  console.error(
    `[Lattice] Pipeline aborted at ${event.data.failedAgentId}: ${event.data.reason}`,
  );
});

// ─── Benchmarking: replay golden dataset through Lattice ──

/**
 * Replay Forge's golden dataset through the Lattice pipeline to measure:
 * - How many golden examples pass L1 validation (baseline structural correctness)
 * - Which steps produce contracts with constraints/assumptions (risk signals)
 * - Average L1 validation overhead per step
 *
 * This is the first step toward the 200-trace benchmark.
 */
// async function benchmarkLinkedInPipeline() {
//   // Load golden dataset
//   const { contentWriterDataset } = await import('../../forge/src/eval/golden-datasets/content-writer');
//
//   const results = await replayPipeline(
//     latticeLinkedIn,
//     contentWriterDataset.examples.map(ex => ({
//       input: ex.input,
//       expected: ex.expectedOutput,
//     })),
//     { maxConcurrency: 3 },
//   );
//
//   // Analyze results
//   const l1PassRate = results.filter(r =>
//     r.contracts.every(c => {
//       const v = validateContract(c);
//       return v.valid;
//     })
//   ).length / results.length;
//
//   const avgOverhead = results.reduce((sum, r) => sum + r.durationMs, 0) / results.length;
//
//   const contractsWithConstraints = results.flatMap(r =>
//     r.contracts.filter(c => c.constraints.length > 0)
//   ).length;
//
//   console.log(`L1 pass rate: ${(l1PassRate * 100).toFixed(1)}%`);
//   console.log(`Avg pipeline duration: ${avgOverhead.toFixed(0)}ms`);
//   console.log(`Contracts with constraints: ${contractsWithConstraints}`);
//
//   return results;
// }

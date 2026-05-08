#!/usr/bin/env node
/**
 * Lattice Quick Start Demo
 *
 * Shows Lattice catching failures in real-time:
 * 1. A healthy pipeline runs successfully
 * 2. A failing agent gets caught by the circuit breaker
 * 3. The State Contract preserves full audit trail
 * 4. Redaction scrubs secrets from logged output
 *
 * Run: npx tsx examples/quick-start/demo.ts
 */

import {
  pipeline,
  createContract,
  TieredCircuitBreaker,
  HandoffFailure,
  redactContract,
  validateContract,
} from '../../packages/core/src/index.js';

// Colors for terminal output
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function header(text: string) {
  console.log(`\n${C.bold}${C.cyan}═══ ${text} ═══${C.reset}\n`);
}

function success(text: string) {
  console.log(`${C.green}✓ ${text}${C.reset}`);
}

function fail(text: string) {
  console.log(`${C.red}✗ ${text}${C.reset}`);
}

function info(text: string) {
  console.log(`${C.blue}  → ${text}${C.reset}`);
}

function dim(text: string) {
  console.log(`${C.gray}  ${text}${C.reset}`);
}

// ─── Demo 1: Healthy Pipeline ──────────────────────────────

async function demoHealthyPipeline() {
  header('Demo 1: Healthy Pipeline');

  console.log('Building a 3-agent research pipeline:\n');
  console.log('  summarizer → extractor → formatter\n');

  const p = pipeline()
    .agent('summarizer', async (input: { text: string }) => {
      return { summary: input.text.slice(0, 80) + '...' };
    }, { breaker: { tier: 'L1' } })
    .agent('extractor', async (input: { summary: string }) => {
      return { keywords: input.summary.split(' ').slice(0, 5) };
    }, { breaker: { tier: 'L1' } })
    .agent('formatter', async (input: { keywords: string[] }) => {
      return { report: `Keywords: ${input.keywords.join(', ')}` };
    }, { breaker: { tier: 'L1' } })
    .build();

  const result = await p.execute({
    text: 'Multi-agent AI systems fail at high rates due to coordination failures, not model quality.',
  });

  success('Pipeline completed successfully');
  info(`Output: ${result.output.report}`);
  info(`Contracts produced: ${result.contracts.length}`);
  info(`Trace ID: ${result.contracts[0].traceId.slice(0, 16)}...`);
  info(`Total time: ${result.totalDurationMs}ms`);

  console.log(`\n${C.gray}Each step produced a State Contract with full lineage.${C.reset}`);
}

// ─── Demo 2: Circuit Breaker Catches Failure ───────────────

async function demoCircuitBreaker() {
  header('Demo 2: Circuit Breaker Catches Failure');

  console.log('Building the same pipeline, but the summarizer crashes:\n');

  const p = pipeline()
    .agent('summarizer', async (_input: { text: string }) => {
      throw new Error('API connection refused: 503 Service Unavailable');
    }, { breaker: { tier: 'L1' } })
    .agent('extractor', async (input: any) => {
      return { keywords: [] };
    }, { breaker: { tier: 'L1' } })
    .build();

  try {
    await p.execute({ text: 'This should fail.' });
    console.log('Should have thrown!');
  } catch (err) {
    if (err instanceof HandoffFailure) {
      fail('Pipeline caught failure');
      info(`Error: ${err.validation.reason}`);
      info(`Detected at tier: ${err.validation.tier}`);
      info(`Contract ID: ${err.contract.id.slice(0, 16)}...`);
      info(`From agent: ${err.contract.fromAgent}`);

      console.log(`\n${C.gray}The circuit breaker caught the failure before it cascaded to downstream agents.${C.reset}`);
      console.log(`${C.gray}The State Contract preserves the error context for debugging.${C.reset}`);

      // Show the contract's constraints
      if (err.contract.constraints.length > 0) {
        console.log(`\n${C.bold}State Contract constraints:${C.reset}`);
        for (const c of err.contract.constraints) {
          console.log(`  ${C.yellow}• ${c.description}${C.reset}`);
        }
      }
    }
  }
}

// ─── Demo 3: Redaction Scrubs Secrets ──────────────────────

async function demoRedaction() {
  header('Demo 3: Redaction Scrubs Secrets');

  console.log('Agent accidentally includes an API key in its output:\n');

  const contract = createContract({
    fromAgent: 'leaky-agent',
    inputs: { query: 'fetch user data' },
    outputs: {
      data: 'user@example.com',
      apiKey: 'sk-prod-abc123def456',
      password: 'hunter2',
    },
    budget: { tokensUsed: 100, callsMade: 1, wallClockMs: 50 },
  });

  console.log(`${C.bold}Before redaction:${C.reset}`);
  dim(JSON.stringify(contract.outputs.payload, null, 2));

  const redacted = redactContract(contract, { sensitivityLevel: 'high' });

  console.log(`\n${C.bold}After redaction:${C.reset}`);
  dim(JSON.stringify(redacted.outputs.payload, null, 2));

  success('API key and password were redacted');
  success('Email address was redacted (pattern matching)');
  info('Contract structure preserved for audit');

  // Verify validation still passes
  const validation = validateContract(redacted);
  success(`Redacted contract validates: ${validation.valid ? 'PASS' : 'FAIL'}`);
}

// ─── Demo 4: Degrade Mode ──────────────────────────────────

async function demoDegradeMode() {
  header('Demo 4: Degrade Mode — Continue on Failure');

  console.log('Circuit breaker rejects output but pipeline continues (flagged):\n');

  const p = pipeline()
    .agent('risky-agent', async (input: { text: string }) => {
      // Agent produces output but with low confidence
      return { summary: input.text, confidence: 0.3 };
    }, { breaker: { tier: 'L1' } })
    .agent('safe-agent', async (input: { summary: string }) => {
      return { final: `Processed: ${input.summary}` };
    }, { breaker: { tier: 'L1' } })
    .onReject('degrade')
    .build();

  const result = await p.execute({ text: 'Important data to process.' });

  success('Pipeline completed in degrade mode');
  info(`Output: ${result.output.final}`);
  info(`Had rejected contracts: ${result.hadRejected}`);
  info(`Contracts produced: ${result.contracts.length}`);

  console.log(`\n${C.gray}Degrade mode lets the pipeline continue but flags rejected contracts${C.reset}`);
  console.log(`${C.gray}for human review downstream.${C.reset}`);
}

// ─── Run All Demos ─────────────────────────────────────────

(async () => {
  console.log(`\n${C.bold}${C.cyan}
┌─────────────────────────────────────────┐
│  @heybeaux/lattice-core v0.1.0         │
│  Coordination Infrastructure Demo      │
└─────────────────────────────────────────┘
${C.reset}`);

  await demoHealthyPipeline();
  await demoCircuitBreaker();
  await demoRedaction();
  await demoDegradeMode();

  header('Summary');

  console.log(`${C.bold}Lattice provides:${C.reset}`);
  console.log(`${C.green}  ✓ State Contracts${C.reset} — full audit trail for every handoff`);
  console.log(`${C.green}  ✓ Circuit Breakers${C.reset} — catch failures before they cascade`);
  console.log(`${C.green}  ✓ Redaction${C.reset} — scrub secrets before logging`);
  console.log(`${C.green}  ✓ Degrade Mode${C.reset} — continue on failure with flagging`);
  console.log(`${C.green}  ✓ Pipeline Builder${C.reset} — compose agents with coordination built in`);
  console.log(`\n${C.gray}Install: npm install @heybeaux/lattice-core${C.reset}`);
  console.log(`${C.gray}Docs:    https://github.com/heybeaux/lattice${C.reset}\n`);
})();

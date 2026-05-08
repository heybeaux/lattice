#!/usr/bin/env node
/**
 * Lattice REAL Benchmark
 *
 * Tests L3 validation with ACTUAL OpenAI API calls.
 * No projections, no assumptions — real numbers.
 *
 * Run: npx tsx benchmark/run-real.ts
 * Requires: OPENAI_API_KEY environment variable
 */

import {
  pipeline,
  createContract,
  TieredCircuitBreaker,
  HandoffFailure,
  redactContract,
  validateContract,
} from '../packages/core/src/index.js';
import { createOpenAIJudgeProvider } from '../packages/provider-openai/src/index.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

// ─── Test Cases ─────────────────────────────────────────────

interface TestCase {
  name: string;
  category: 'structural' | 'semantic' | 'redaction' | 'false-positive';
  input: unknown;
  agentFn: (input: unknown) => Promise<unknown> | unknown;
  shouldFail: boolean;
  expectedDetection: 'L1' | 'L3' | 'redaction' | 'none';
  description: string;
}

const TESTS: TestCase[] = [
  // ─── Structural (L1) ───
  {
    name: 'agent-throws',
    category: 'structural',
    input: { text: 'test' },
    agentFn: async () => { throw new Error('API connection refused'); },
    shouldFail: true,
    expectedDetection: 'L1',
    description: 'Agent crashes with exception',
  },
  {
    name: 'empty-output',
    category: 'semantic',
    input: { text: 'Summarize this important document about AI safety.' },
    agentFn: async () => ({ summary: '' }),
    shouldFail: true,
    expectedDetection: 'L3',
    description: 'Agent returns empty summary',
  },
  {
    name: 'hallucination-facts',
    category: 'semantic',
    input: { text: 'What does the document say about AI safety?' },
    agentFn: async () => ({
      summary: 'The document states that OpenAI released GPT-7 on March 15, 2026, and that Google DeepMind achieved AGI on January 3, 2026.',
      sources: ['Reuters, March 15', 'TechCrunch, January 3'],
    }),
    shouldFail: true,
    expectedDetection: 'L3',
    description: 'Agent invents specific facts (GPT-7, AGI) not in input',
  },
  {
    name: 'hallucination-citations',
    category: 'semantic',
    input: { text: 'Extract entities from the text.' },
    agentFn: async () => ({
      entities: ['John Smith (CEO of Tesla)'],
      keyPoints: ['Partnership announced'],
      citations: ['Reuters, Jan 15 2026', 'Bloomberg, Jan 16 2026'],
    }),
    shouldFail: true,
    expectedDetection: 'L3',
    description: 'Agent invents citations that do not exist',
  },
  {
    name: 'off-topic',
    category: 'semantic',
    input: { text: 'Summarize this document about AI safety regulations.' },
    agentFn: async () => ({
      summary: 'The best pizza topping is pineapple. Studies show 73% of people agree.',
      sources: [],
    }),
    shouldFail: true,
    expectedDetection: 'L3',
    description: 'Agent output is completely unrelated to input',
  },
  {
    name: 'contradictory-output',
    category: 'semantic',
    input: { text: 'The company reported revenue of $10M in Q4.' },
    agentFn: async () => ({
      summary: 'The company lost $50M in Q4, with revenue declining to zero.',
      sources: [],
    }),
    shouldFail: true,
    expectedDetection: 'L3',
    description: 'Agent output contradicts the input',
  },
  {
    name: 'partial-answer',
    category: 'semantic',
    input: { text: 'Extract all entities and key points from this document about AI, climate change, and economics.' },
    agentFn: async () => ({
      entities: ['AI'],
      keyPoints: [],
      citations: [],
    }),
    shouldFail: true,
    expectedDetection: 'L3',
    description: 'Agent only extracts one of three requested topics',
  },
  {
    name: 'valid-summary',
    category: 'false-positive',
    input: { text: 'Multi-agent AI systems fail at high rates due to coordination failures, not model quality.' },
    agentFn: async () => ({
      summary: 'Multi-agent AI systems fail due to coordination issues rather than model quality problems.',
      sources: ['source1'],
    }),
    shouldFail: false,
    expectedDetection: 'none',
    description: 'Correct summary that should pass L3',
  },
  {
    name: 'valid-extraction',
    category: 'false-positive',
    input: { text: 'The CEO announced a new AI initiative.' },
    agentFn: async () => ({
      entities: ['CEO', 'AI initiative'],
      keyPoints: ['New initiative announced'],
      citations: [],
    }),
    shouldFail: false,
    expectedDetection: 'none',
    description: 'Correct extraction that should pass L3',
  },
  {
    name: 'valid-format',
    category: 'false-positive',
    input: { text: 'Format the report for publication.' },
    agentFn: async () => ({
      report: '# Report\n\nMulti-agent systems need better coordination.\n\nThis is well-supported by the evidence.',
    }),
    shouldFail: false,
    expectedDetection: 'none',
    description: 'Correctly formatted output that should pass L3',
  },
  {
    name: 'valid-short-answer',
    category: 'false-positive',
    input: { text: 'What is 2+2?' },
    agentFn: async () => ({
      answer: '4',
    }),
    shouldFail: false,
    expectedDetection: 'none',
    description: 'Short but correct answer that should pass L3',
  },
  {
    name: 'api-key-leak',
    category: 'redaction',
    input: { text: 'fetch data' },
    agentFn: async () => ({
      data: 'useful info',
      apiKey: 'sk-prod-abc123def456',
      password: 'hunter2',
    }),
    shouldFail: false,
    expectedDetection: 'redaction',
    description: 'Agent leaks API key and password',
  },
  {
    name: 'email-leak',
    category: 'redaction',
    input: { text: 'fetch user profile' },
    agentFn: async () => ({
      user: 'john@example.com',
      phone: '555-123-4567',
    }),
    shouldFail: false,
    expectedDetection: 'redaction',
    description: 'Agent leaks email and phone number',
  },
];

// ─── Benchmark Runner ──────────────────────────────────────

interface TestResult {
  test: TestCase;
  detected: boolean;
  detectionTier: string | null;
  durationMs: number;
  judgeVerdict?: string;
  judgeConfidence?: number;
  judgeReasoning?: string;
  l1Result?: string;
}

async function runTest(test: TestCase): Promise<TestResult> {
  const start = Date.now();
  let detected = false;
  let detectionTier: string | null = null;
  let judgeVerdict: string | undefined;
  let judgeConfidence: number | undefined;
  let judgeReasoning: string | undefined;

  // ─── L1 Test (structural) ───
  try {
    const p = pipeline()
      .agent('test-agent', test.agentFn as any, { breaker: { tier: 'L1' } })
      .build();

    const result = await p.execute(test.input as any);

    // L1 passed — check if this is a redaction test
    if (test.category === 'redaction') {
      for (const contract of result.contracts) {
        const redacted = redactContract(contract, { sensitivityLevel: 'high' });
        const payloadStr = JSON.stringify(redacted.outputs.payload);
        const metadataStr = JSON.stringify(redacted.metadata);
        const hasSecret = payloadStr.includes('sk-') || payloadStr.includes('ghp_') ||
                         payloadStr.includes('hunter2') ||
                         metadataStr.includes('sk-') || metadataStr.includes('ghp_');
        const hasEmail = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.test(payloadStr);
        const hasPhone = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(payloadStr);
        if (!hasSecret && !hasEmail && !hasPhone) {
          detected = true;
          detectionTier = 'redaction';
        }
      }
    }

    // If it's a false-positive test and L1 passed, that's correct
    if (test.category === 'false-positive') {
      detected = false; // We expect it to NOT fail
    }
  } catch (err) {
    if (err instanceof HandoffFailure) {
      detected = true;
      detectionTier = 'L1';
    }
  }

  // ─── L3 Test (semantic) — only for semantic categories ───
  if (!detected && (test.category === 'semantic' || test.category === 'false-positive')) {
    try {
      // Run the agent to get output
      const output = await test.agentFn(test.input);

      // Create a contract
      const contract = createContract({
        fromAgent: 'test-agent',
        inputs: test.input,
        outputs: output,
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: Date.now() - start },
      });

      // Run L3 validation
      const breaker = new TieredCircuitBreaker({ tier: 'L1+L3' });
      const judge = createOpenAIJudgeProvider({ apiKey: OPENAI_API_KEY, model: 'gpt-4o-mini' });
      breaker.setJudgeProvider(judge);

      const l1Validation = validateContract(contract);

      if (!l1Validation.valid) {
        detected = true;
        detectionTier = 'L1';
      } else {
        const l3Validation = await breaker.validate(contract);

        judgeVerdict = l3Validation.confidence !== undefined
          ? (l3Validation.confidence > 0.7 ? 'pass' : l3Validation.confidence > 0 ? 'uncertain' : 'fail')
          : undefined;
        judgeConfidence = l3Validation.confidence;
        judgeReasoning = l3Validation.reasoning;

        if (!l3Validation.passed) {
          detected = true;
          detectionTier = 'L3';
        }
      }
    } catch (err) {
      if (err instanceof HandoffFailure) {
        detected = true;
        detectionTier = err.validation.tier;
        judgeConfidence = err.validation.confidence;
        judgeReasoning = err.validation.reasoning;
      }
    }
  }

  return {
    test,
    detected,
    detectionTier,
    durationMs: Date.now() - start,
    judgeVerdict,
    judgeConfidence,
    judgeReasoning,
  };
}

// ─── Report ────────────────────────────────────────────────

function printReport(results: TestResult[]) {
  console.log('\n' + '='.repeat(70));
  console.log('  LATTICE REAL BENCHMARK — May 8, 2026');
  console.log('  Testing with ACTUAL OpenAI API calls (gpt-4o-mini)');
  console.log('='.repeat(70) + '\n');

  const byCategory = new Map<string, TestResult[]>();
  for (const r of results) {
    const cat = r.test.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(r);
  }

  let totalTests = 0;
  let totalCorrect = 0;
  let totalFalsePositive = 0; // Good output incorrectly rejected
  let totalFalseNegative = 0; // Bad output incorrectly accepted

  for (const [category, catResults] of byCategory) {
    const label = category === 'structural' ? 'L1 (structural failures)' :
                  category === 'semantic' ? 'L3 (semantic failures — hallucinations, wrong content)' :
                  category === 'false-positive' ? 'False Positive (correct output should pass)' :
                  'Redaction (PII scrubbing)';
    console.log(`── ${label} ──\n`);

    for (const r of catResults) {
      const shouldFail = r.test.shouldFail;
      const isCorrect = shouldFail === r.detected;

      const status = isCorrect ? '✅' :
                     shouldFail && !r.detected ? '❌' : '⚠️';

      const detail = r.detectionTier ? ` [${r.detectionTier}]` :
                     !shouldFail && r.detected ? ` [incorrectly rejected]` : '';

      console.log(`  ${status} ${r.test.name}${detail}`);
      if (r.judgeReasoning) {
        console.log(`     → Judge: ${r.judgeReasoning.slice(0, 120)}`);
      }
      if (r.judgeConfidence !== undefined) {
        console.log(`     → Confidence: ${r.judgeConfidence.toFixed(2)}`);
      }
      if (!isCorrect) {
        console.log(`     → Expected: ${shouldFail ? 'detect failure' : 'pass'}, Got: ${r.detected ? 'detected' : 'passed'}`);
      }

      totalTests++;
      if (isCorrect) totalCorrect++;
      if (shouldFail && !r.detected) totalFalseNegative++;
      if (!shouldFail && r.detected) totalFalsePositive++;
    }

    const catCorrect = catResults.filter(r => r.test.shouldFail === r.detected).length;
    console.log(`  ${catCorrect}/${catResults.length} correct\n`);
  }

  console.log('═'.repeat(70));
  console.log('  SUMMARY');
  console.log('═'.repeat(70) + '\n');
  console.log(`  Total tests:         ${totalTests}`);
  console.log(`  Correct:             ${totalCorrect} (${((totalCorrect / totalTests) * 100).toFixed(0)}%)`);
  console.log(`  False negatives:     ${totalFalseNegative} (bad output NOT detected)`);
  console.log(`  False positives:     ${totalFalsePositive} (good output incorrectly rejected)`);

  const semanticTests = results.filter(r => r.test.category === 'semantic');
  const semanticDetected = semanticTests.filter(r => r.detected).length;
  console.log(`\n  L3 detection rate:   ${semanticTests.length > 0 ? ((semanticDetected / semanticTests.length) * 100).toFixed(0) : 'N/A'}% (${semanticDetected}/${semanticTests.length})`);

  const fpTests = results.filter(r => r.test.category === 'false-positive');
  const fpPassed = fpTests.filter(r => !r.detected).length;
  console.log(`  FP rate:             ${fpTests.length > 0 ? ((1 - fpPassed / fpTests.length) * 100).toFixed(0) : 'N/A'}% (${fpTests.length - fpPassed} good outputs rejected)`);

  const totalL3 = [...semanticTests, ...fpTests];
  const l3Detected = totalL3.filter(r => r.detected && r.detectionTier === 'L3').length;
  const l3Total = totalL3.length;
  console.log(`  Combined L1+L3:      ${l3Total > 0 ? ((l3Detected / l3Total) * 100).toFixed(0) : 'N/A'}% (${l3Detected}/${l3Total} semantic detected)`);

  const avgLatency = results.reduce((s, r) => s + r.durationMs, 0) / results.length;
  console.log(`  Avg latency:         ${avgLatency.toFixed(0)}ms`);

  console.log('\n' + '='.repeat(70));
}

// ─── Run ───────────────────────────────────────────────────

(async () => {
  console.log('\nRunning benchmark with real OpenAI API calls...\n');

  const results: TestResult[] = [];

  // Run L1 + redaction tests first (fast, no API calls)
  const fastTests = TESTS.filter(t => t.category !== 'semantic' && t.category !== 'false-positive');
  for (const test of fastTests) {
    process.stdout.write(`  ${test.name}... `);
    const result = await runTest(test);
    results.push(result);
    console.log(result.detected ? `✅ [${result.detectionTier}]` : '✅ passed');
  }

  // Run L3 tests (need API calls)
  const l3Tests = TESTS.filter(t => t.category === 'semantic' || t.category === 'false-positive');
  for (const test of l3Tests) {
    process.stdout.write(`  ${test.name} (L3)... `);
    const result = await runTest(test);
    results.push(result);
    const status = result.detected ? `✅ [${result.detectionTier}]` : '✅ passed';
    console.log(status);
  }

  printReport(results);
})();

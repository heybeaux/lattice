#!/usr/bin/env node
/**
 * Lattice Forge Shadow Mode Benchmark Runner
 * 
 * Runs the Lattice documentation generation workflow through Forge
 * with Lattice shadow mode enabled, collecting benchmark data.
 * 
 * Usage:
 *   cd ~/forge
 *   export OPENAI_API_KEY="your-key"
 *   node /path/to/lattice/forge-integration/run-benchmark.mjs
 */

import fs from 'fs';
import path from 'path';

// ─── Configuration ──────────────────────────────────────────

const LOG_PATH = process.env.LATTICE_SHADOW_LOG ?? './lattice-shadow-audit.jsonl';
const TOPICS_FILE = process.env.LATTICE_TOPICS ?? '../lattice/forge-integration/lattice-docs-topics.json';
const MAX_TOPICS = parseInt(process.env.LATTICE_MAX_TOPICS ?? '50', 10);
const REPORT_PATH = process.env.LATTICE_REPORT ?? './lattice-benchmark-report.json';

console.log('═══════════════════════════════════════════════════');
console.log('  Lattice Forge Shadow Mode Benchmark');
console.log('═══════════════════════════════════════════════════');
console.log('');
console.log(`Audit log:     ${LOG_PATH}`);
console.log(`Topics file:   ${TOPICS_FILE}`);
console.log(`Max topics:    ${MAX_TOPICS}`);
console.log(`Report path:   ${REPORT_PATH}`);
console.log('');

// Clear previous audit log
fs.writeFileSync(LOG_PATH, '');

// Check prerequisites
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is required');
  process.exit(1);
}

if (!fs.existsSync(TOPICS_FILE)) {
  console.error(`ERROR: Topics file not found: ${TOPICS_FILE}`);
  process.exit(1);
}

// Load topics
const topics = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf-8'));
const topicsToRun = topics.slice(0, MAX_TOPICS);

console.log(`Total topics available: ${topics.length}`);
console.log(`Processing: ${topicsToRun.length}`);
console.log('');

// ─── Run ───────────────────────────────────────────────────

const START_TIME = Date.now();
let completed = 0;
let failed = 0;

// Dynamically import the Mastra instance and workflow
let mastra;
try {
  const mastraModule = await import('./src/mastra/index.js');
  mastra = mastraModule.mastra ?? mastraModule.default;
} catch (err) {
  console.error('ERROR: Could not import Mastra instance.');
  console.error('Make sure this script is run from the Forge root directory.');
  console.error(`Import error: ${err.message}`);
  process.exit(1);
}

const workflow = mastra.getWorkflow?.('lattice-doc-gen');
if (!workflow) {
  console.error('ERROR: Workflow "lattice-doc-gen" not found in Mastra.');
  console.error('Make sure the workflow is registered in your Mastra instance.');
  process.exit(1);
}

for (const topic of topicsToRun) {
  completed++;
  console.log(`[${completed}/${topicsToRun.length}] ${topic.topic} (${topic.docType})`);

  try {
    const result = await workflow.execute({
      inputData: {
        topic: topic.topic,
        docType: topic.docType,
        targetAudience: topic.targetAudience ?? '',
      },
    });

    const title = result?.output?.metadata?.title ?? 'no title';
    console.log(`  → Done: ${title}`);
  } catch (err) {
    failed++;
    console.error(`  → Failed: ${err.message}`);
  }

  console.log('');
}

// ─── Report ────────────────────────────────────────────────

const END_TIME = Date.now();
const DURATION = Math.round((END_TIME - START_TIME) / 1000);

console.log('═══════════════════════════════════════════════════');
console.log('  Benchmark Complete');
console.log('═══════════════════════════════════════════════════');
console.log('');
console.log(`Duration: ${Math.floor(DURATION / 60)}m ${DURATION % 60}s`);
console.log(`Completed: ${completed} topics`);
console.log(`Failed: ${failed} topics`);
console.log('');
console.log(`Audit log: ${LOG_PATH}`);

if (fs.existsSync(LOG_PATH)) {
  const content = fs.readFileSync(LOG_PATH, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const TOTAL_LINES = lines.length;
  console.log(`Total handoff validations: ${TOTAL_LINES}`);

  if (TOTAL_LINES > 0) {
    const entries = lines.map(l => JSON.parse(l));
    const PASSED = entries.filter(e => e.validation?.passed).length;
    const FAILED_VAL = entries.filter(e => !e.validation?.passed).length;

    console.log(`Passed: ${PASSED}`);
    console.log(`Failed: ${FAILED_VAL}`);

    const L1_COUNT = entries.filter(e => e.validation?.tier === 'L1').length;
    const L2_COUNT = entries.filter(e => e.validation?.tier === 'L2').length;
    const L3_COUNT = entries.filter(e => e.validation?.tier === 'L3').length;

    console.log('');
    console.log('By tier:');
    console.log(`  L1: ${L1_COUNT}`);
    console.log(`  L2: ${L2_COUNT}`);
    console.log(`  L3: ${L3_COUNT}`);
  }
}

console.log('');
console.log('Next steps:');
console.log('1. Review audit log: ' + LOG_PATH);
console.log('2. Generate report: node ' + path.join(path.dirname(new URL(import.meta.url).pathname), 'generate-report.js') + ' ' + LOG_PATH);
console.log('3. Publish results');

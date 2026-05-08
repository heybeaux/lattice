#!/usr/bin/env node
/**
 * Lattice Forge Benchmark Report Generator
 * 
 * Reads the shadow mode audit log and generates a benchmark report.
 * 
 * Usage: node forge-integration/generate-report.js [log-path]
 */

import fs from 'fs';
import path from 'path';

const logPath = process.argv[2] || './lattice-shadow-audit.jsonl';
const reportPath = './lattice-benchmark-report.json';

if (!fs.existsSync(logPath)) {
  console.error(`Audit log not found: ${logPath}`);
  process.exit(1);
}

// Read all entries
const entries = fs.readFileSync(logPath, 'utf-8')
  .split('\n')
  .filter(line => line.trim())
  .map(line => JSON.parse(line));

console.log(`Read ${entries.length} audit entries from ${logPath}`);

// ─── Analysis ──────────────────────────────────────────────

// By step
const byStep = new Map();
for (const e of entries) {
  if (!byStep.has(e.stepId)) byStep.set(e.stepId, []);
  byStep.get(e.stepId).push(e);
}

// By tier
const byTier = new Map();
for (const e of entries) {
  if (!byTier.has(e.validation.tier)) byTier.set(e.validation.tier, []);
  byTier.get(e.validation.tier).push(e);
}

// Pass/fail rates
const totalValidations = entries.length;
const passed = entries.filter(e => e.validation.passed).length;
const failed = totalValidations - passed;

// Latency by tier
const latencyByTier = {};
for (const [tier, tierEntries] of byTier) {
  const latencies = tierEntries.map(e => e.latencyMs);
  latencyByTier[tier] = {
    count: latencies.length,
    mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    median: latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)],
    p95: latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)],
    max: Math.max(...latencies),
    min: Math.min(...latencies),
  };
}

// Failure reasons
const failureReasons = new Map();
for (const e of entries) {
  if (!e.validation.passed && e.validation.reason) {
    const reason = e.validation.reason.split(':')[0]; // Group by prefix
    failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
  }
}

// Confidence distribution (L3 only)
const l3Entries = byTier.get('L3') || [];
const confidenceBuckets = { '0.0-0.2': 0, '0.2-0.4': 0, '0.4-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0 };
for (const e of l3Entries) {
  if (e.validation.confidence !== undefined) {
    const bucket = e.validation.confidence < 0.2 ? '0.0-0.2' :
                   e.validation.confidence < 0.4 ? '0.2-0.4' :
                   e.validation.confidence < 0.6 ? '0.4-0.6' :
                   e.validation.confidence < 0.8 ? '0.6-0.8' : '0.8-1.0';
    confidenceBuckets[bucket]++;
  }
}

// Redaction effectiveness
const redactionTests = entries.filter(e => 
  e.inputSummary.toLowerCase().includes('api') || 
  e.inputSummary.toLowerCase().includes('key') ||
  e.outputSummary.toLowerCase().includes('sk-')
);

// ─── Report ────────────────────────────────────────────────

const report = {
  metadata: {
    generatedAt: new Date().toISOString(),
    logPath,
    totalEntries: totalValidations,
  },
  summary: {
    totalValidations,
    passed,
    failed,
    passRate: ((passed / totalValidations) * 100).toFixed(1) + '%',
    failRate: ((failed / totalValidations) * 100).toFixed(1) + '%',
  },
  byTier: Object.fromEntries(
    [...byTier.entries()].map(([tier, tierEntries]) => [
      tier,
      {
        count: tierEntries.length,
        passed: tierEntries.filter(e => e.validation.passed).length,
        failed: tierEntries.filter(e => !e.validation.passed).length,
        latency: latencyByTier[tier],
      }
    ])
  ),
  byStep: Object.fromEntries(
    [...byStep.entries()].map(([step, stepEntries]) => [
      step,
      {
        count: stepEntries.length,
        passed: stepEntries.filter(e => e.validation.passed).length,
        failed: stepEntries.filter(e => !e.validation.passed).length,
      }
    ])
  ),
  failureReasons: Object.fromEntries(failureReasons),
  confidenceDistribution: confidenceBuckets,
  topFailures: entries
    .filter(e => !e.validation.passed)
    .slice(0, 20)
    .map(e => ({
      stepId: e.stepId,
      tier: e.validation.tier,
      reason: e.validation.reason,
      inputSummary: e.inputSummary.slice(0, 100),
      outputSummary: e.outputSummary.slice(0, 100),
    })),
};

// Write report
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

// Print summary
console.log('\n' + '='.repeat(60));
console.log('  LATTICE FORGE BENCHMARK REPORT');
console.log('='.repeat(60));
console.log('\n');
console.log(`Total handoff validations: ${totalValidations}`);
console.log(`Passed: ${passed} (${((passed / totalValidations) * 100).toFixed(1)}%)`);
console.log(`Failed: ${failed} (${((failed / totalValidations) * 100).toFixed(1)}%)`);

console.log('\nBy tier:');
for (const [tier, stats] of Object.entries(report.byTier)) {
  console.log(`  ${tier}: ${stats.count} validations, ${stats.passed} passed, ${stats.failed} failed`);
  if (stats.latency) {
    console.log(`       Latency: mean=${stats.latency.mean.toFixed(0)}ms, p95=${stats.latency.p95.toFixed(0)}ms`);
  }
}

console.log('\nBy step:');
for (const [step, stats] of Object.entries(report.byStep)) {
  console.log(`  ${step}: ${stats.count} handoffs, ${stats.passed} passed, ${stats.failed} failed`);
}

if (Object.keys(failureReasons).length > 0) {
  console.log('\nFailure reasons:');
  for (const [reason, count] of Object.entries(failureReasons)) {
    console.log(`  ${reason}: ${count}`);
  }
}

console.log('\nConfidence distribution (L3):');
for (const [bucket, count] of Object.entries(confidenceBuckets)) {
  console.log(`  ${bucket}: ${count}`);
}

console.log('\n' + '='.repeat(60));
console.log(`Report written to: ${reportPath}`);

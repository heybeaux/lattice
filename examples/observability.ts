#!/usr/bin/env node
/**
 * Observability Example
 *
 * Demonstrates JsonLineExporter and OtelExporter attached to globalEmitter.
 *
 * JsonLineExporter writes every Lattice event to a .jsonl file — no extra
 * dependencies needed.
 *
 * OtelExporter sends spans to an OTLP backend (e.g. Jaeger). It degrades
 * gracefully when @opentelemetry/* packages are not installed.
 *
 * Run: npx tsx examples/observability.ts
 *
 * Optional: Start a local Jaeger instance to view OTel traces:
 *   docker run -d -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
 *   # Then open http://localhost:16686 and search for service "lattice-demo"
 */

import * as fs from 'fs';
import {
  JsonLineExporter,
  OtelExporter,
  globalEmitter,
  pipeline,
  createContract,
} from '../packages/core/src/index.js';

const LOG_FILE = './tmp/lattice-events.jsonl';

// Ensure the tmp directory exists
if (!fs.existsSync('./tmp')) {
  fs.mkdirSync('./tmp', { recursive: true });
}

// ─── JSON-line exporter ───────────────────────────────────────────────────────

const jsonExporter = new JsonLineExporter({
  outputPath: LOG_FILE,
  version: '0.4.0',
});

jsonExporter.attach(globalEmitter);
console.log(`JSON-line exporter attached → ${LOG_FILE}`);

// ─── OTel exporter ────────────────────────────────────────────────────────────

const otelExporter = new OtelExporter({
  endpoint: 'http://localhost:4318/v1/traces',
  serviceName: 'lattice-demo',
  protocol: 'http',
});

otelExporter.attach(globalEmitter);
console.log('OTel exporter attached → http://localhost:4318/v1/traces');
console.log('  (Degrades gracefully if @opentelemetry/* not installed)\n');

// ─── Run a pipeline to generate events ───────────────────────────────────────

console.log('=== Observability Demo ===\n');
console.log('Running a 2-agent pipeline to generate events...\n');

const p = pipeline()
  .agent(
    'researcher',
    async (input: { query: string }) => {
      return {
        summary: `Research summary for: ${input.query}`,
        sources: ['arxiv:2301.00001', 'arxiv:2301.00002'],
      };
    },
    { breaker: { tier: 'L1' } },
  )
  .agent(
    'writer',
    async (input: { summary: string; sources: string[] }) => {
      return {
        report: `Report: ${input.summary}. References: ${input.sources.join(', ')}`,
      };
    },
    { breaker: { tier: 'L1' } },
  )
  .build();

const result = await p.execute({ query: 'AI multi-agent coordination' });

console.log('Pipeline result:');
console.log(`  output:           ${(result.output as { report: string }).report}`);
console.log(`  contracts:        ${result.contracts.length}`);
console.log(`  totalDurationMs:  ${result.totalDurationMs}ms\n`);

// ─── Also emit a manual contract validation event ─────────────────────────────

// The JsonLineExporter also picks up individual contract events emitted by
// wrapAgent / TieredCircuitBreaker outside a pipeline.
const contract = createContract({
  fromAgent: 'standalone-agent',
  inputs: { task: 'summarize document' },
  outputs: { summary: 'Key points: coordination, reliability, observability.' },
  budget: { tokensUsed: 150, callsMade: 1, wallClockMs: 320 },
});

// Emit manually for demonstration purposes
globalEmitter.emit('contract:emitted', {
  type: 'contract:emitted',
  timestamp: new Date().toISOString(),
  data: {
    contractId: contract.id,
    fromAgent: contract.fromAgent,
    traceId: contract.traceId,
  },
});

// ─── Read and display the JSON-line log ──────────────────────────────────────

// Small delay to ensure all sync writes are flushed
await new Promise(resolve => setTimeout(resolve, 50));

console.log('--- JSON-line log entries ---\n');
const entries = jsonExporter.readEntries();

for (const entry of entries) {
  console.log(
    `  [${entry.timestamp.slice(11, 23)}] ${entry.event_type.padEnd(22)} ` +
    `agent=${entry.metadata.agent_id ?? '-'} trace=${entry.metadata.trace_id?.slice(0, 10) ?? '-'}`,
  );
}

console.log(`\nTotal entries logged: ${entries.length}`);
console.log(`Full log at:          ${LOG_FILE}\n`);

// ─── OTel span demo (manual) ─────────────────────────────────────────────────

console.log('--- Manual OTel span ---');
const span = otelExporter.startSpan('lattice.custom.operation', {
  'lattice.trace_id': contract.traceId,
  'lattice.agent_id': 'standalone-agent',
  'custom.attribute': 'demo-value',
});
// ... do work ...
otelExporter.endSpan(span, 'ok');
console.log(`  span created: ${span.name} (spanId=${span.spanId.slice(0, 8)})`);
console.log(`  traceId: ${span.traceId.slice(0, 16)}...\n`);

// Clean up
otelExporter.detach(globalEmitter);
console.log('OTel exporter detached. JSON-line log remains at', LOG_FILE);

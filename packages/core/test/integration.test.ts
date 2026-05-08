import { describe, it, expect, vi } from 'vitest';
import {
  pipeline,
  wrapAgent,
  createContract,
  validateContract,
  redactContract,
  HandoffFailure,
  TieredCircuitBreaker,
  EventEmitter,
  globalEmitter,
} from '../src/index.js';
import type { JudgeProvider, EmbeddingProvider } from '../src/index.js';

/**
 * Integration smoke test — exercises every primitive in a single
 * end-to-end pipeline to prove they all work together.
 *
 * Scenario: A research → draft → edit pipeline where:
 * - researcher finds data (with a fake API key in output — tests redaction)
 * - drafter writes a report from the data
 * - editor finalizes the report
 * - Circuit breakers validate each handoff at L1
 * - Events are emitted for each step
 * - Final output is redacted before logging
 */
describe('Integration: full pipeline', () => {
  it('exercises all primitives together', async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const emitter = new EventEmitter();

    // Subscribe to all pipeline events
    emitter.on('contract:emitted', (e) => events.push({ type: e.type, data: e.data }));
    emitter.on('contract:validated', (e) => events.push({ type: e.type, data: e.data }));
    emitter.on('pipeline:started', (e) => events.push({ type: e.type, data: e.data }));
    emitter.on('pipeline:completed', (e) => events.push({ type: e.type, data: e.data }));

    // ── Build and execute pipeline ──
    const pipeline_ = pipeline()
      .agent('researcher', async (input: { query: string }) => {
        return {
          findings: `Results for "${input.query}"`,
          apiKey: 'sk-secret-do-not-log', // should be redacted later
          sources: ['paper1', 'paper2'],
        };
      }, { breaker: { tier: 'L1' } })
      .agent('drafter', (input: { findings: string; sources: string[] }) => {
        return {
          report: `# Research Report\n\n${input.findings}\n\nSources: ${input.sources.join(', ')}`,
        };
      }, { breaker: { tier: 'L1' } })
      .agent('editor', (input: { report: string }) => {
        return {
          finalReport: input.report + '\n\n---\nEdited and approved.',
        };
      }, { breaker: { tier: 'L1' } })
      .build();

    emitter.pipelineStarted(['researcher', 'drafter', 'editor'], 'integration-test');

    const result = await pipeline_.execute({ query: 'AI coordination failures' });

    emitter.pipelineCompleted(
      'integration-test',
      result.contracts.length,
      result.totalDurationMs,
      result.hadRejected,
    );

    // ── Verify results ──

    // Pipeline produced output
    expect(result.output.finalReport).toContain('Research Report');
    expect(result.output.finalReport).toContain('AI coordination failures');
    expect(result.output.finalReport).toContain('Edited and approved');

    // Three contracts produced
    expect(result.contracts).toHaveLength(3);
    expect(result.contracts[0].fromAgent).toBe('researcher');
    expect(result.contracts[1].fromAgent).toBe('drafter');
    expect(result.contracts[2].fromAgent).toBe('editor');

    // All contracts share the same traceId
    const traceId = result.contracts[0].traceId;
    expect(result.contracts[1].traceId).toBe(traceId);
    expect(result.contracts[2].traceId).toBe(traceId);

    // Events were emitted
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('pipeline:started');
    expect(eventTypes).toContain('pipeline:completed');

    // ── Verify redaction on researcher contract ──
    const researcherContract = result.contracts[0];
    const redacted = redactContract(researcherContract, { sensitivityLevel: 'high' });

    // API key was redacted
    expect((redacted.outputs.payload as any).apiKey).toBe('[REDACTED]');
    // Other data preserved
    expect((redacted.outputs.payload as any).findings).toContain('AI coordination failures');
    expect((redacted.outputs.payload as any).sources).toEqual(['paper1', 'paper2']);

    // ── Verify contract validation ──
    for (const contract of result.contracts) {
      const validation = validateContract(contract);
      expect(validation.valid).toBe(true);
    }

    // ── Verify duration tracked ──
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.hadRejected).toBe(false);
  });

  it('TieredCircuitBreaker with all three tiers works end-to-end', async () => {
    const mockEmbedding: EmbeddingProvider = {
      embed: async (text) => {
        // Simple hash-based embedding (not real, just for testing)
        const hash = text.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        return [hash % 100, (hash * 7) % 100, (hash * 13) % 100];
      },
      similarity: (a, b) => {
        const dot = a.reduce((s, v, i) => s + v * b[i], 0);
        const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
        const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
        return magA * magB > 0 ? dot / (magA * magB) : 0;
      },
    };

    const mockJudge: JudgeProvider = {
      judge: async (task, output) => {
        return {
          verdict: output.length > 10 ? 'pass' : 'fail',
          confidence: 0.85,
        };
      },
    };

    const breaker = new TieredCircuitBreaker({
      tier: 'L1+L2+L3',
      l2Threshold: 0.5,
      l3ConfidenceThreshold: 0.7,
    });

    breaker.setEmbeddingProvider(mockEmbedding);
    breaker.setJudgeProvider(mockJudge);

    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'explain quantum computing' },
      outputs: { answer: 'Quantum computing uses qubits that can exist in superposition...' },
      budget: { tokensUsed: 500, callsMade: 1, wallClockMs: 200 },
    });

    const result = await breaker.validate(contract);

    expect(result.passed).toBe(true);
    expect(result.tier).toBe('L3');
    expect(result.confidence).toBe(0.85);
  });

  it('wrapAgent with degrade mode + redaction forms a complete safety loop', async () => {
    // Agent that produces output with a secret
    const risky = wrapAgent(
      () => ({
        data: 'useful info',
        secretKey: 'sk-prod-12345',
      }),
      {
        id: 'risky',
        breaker: { tier: 'L1+L3', onReject: 'degrade' },
      },
    );

    // Without judge provider → L3 fails → degrade mode
    const contract = await risky({});

    // Degrade mode returns flagged contract
    expect((contract.metadata as any).validationStatus).toBe('rejected');

    // Redaction scrubs the secret
    const redacted = redactContract(contract);
    expect((redacted.outputs.payload as any).secretKey).toBe('[REDACTED]');
    expect((redacted.outputs.payload as any).data).toBe('useful info');
  });
});

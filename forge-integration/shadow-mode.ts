/**
 * Lattice Shadow Mode for Forge
 * 
 * Wraps Mastra workflow steps with Lattice State Contracts and Circuit Breakers
 * in SHADOW MODE — logs every handoff without blocking execution.
 * 
 * This produces the benchmark data we need without affecting Forge's output.
 */

import {
  createContract,
  validateContract,
  TieredCircuitBreaker,
  HandoffFailure,
  redactContract,
  globalEmitter,
} from '@heybeaux/lattice-core';
import { createOpenAIJudgeProvider, createOpenAIEmbeddingProvider } from '@heybeaux/lattice-provider-openai';
import * as fs from 'fs';
import * as path from 'path';

// ─── Configuration ──────────────────────────────────────────

interface ShadowModeConfig {
  /** Where to write the JSONL audit log */
  logPath: string;
  /** OpenAI API key for L3 validation */
  openaiApiKey: string;
  /** L3 confidence threshold for escalation (default: 0.85) */
  l3Threshold?: number;
  /** Whether to actually block on failures (default: false = shadow mode) */
  blockOnFailure?: boolean;
  /** Which tiers to run (default: 'L1+L2+L3') */
  tier?: 'L1' | 'L1+L2' | 'L1+L3' | 'L1+L2+L3';
}

// ─── Audit Log ──────────────────────────────────────────────

interface AuditEntry {
  timestamp: string;
  runId: string;
  traceId: string;
  stepId: string;
  fromAgent: string;
  validation: {
    tier: string;
    passed: boolean;
    confidence?: number;
    reason?: string;
  };
  inputSummary: string;
  outputSummary: string;
  latencyMs: number;
  contract: any; // redacted State Contract
}

function createAuditLogger(config: ShadowModeConfig) {
  const logPath = config.logPath;
  
  // Ensure directory exists
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return function log(entry: AuditEntry) {
    const line = JSON.stringify(entry);
    fs.appendFileSync(logPath, line + '\n');
  };
}

// ─── Shadow Mode Wrapper ────────────────────────────────────

/**
 * Create a shadow-mode wrapper for a Mastra step.
 * 
 * The step executes normally. Lattice:
 * 1. Creates a State Contract for the handoff
 * 2. Validates through L1 (schema) + L2 (embedding) + L3 (LLM-as-judge)
 * 3. Logs the result to JSONL audit log
 * 4. Only blocks if blockOnFailure is true
 * 
 * @param stepId - Unique step identifier
 * @param executeFn - The original step execution function
 * @param config - Shadow mode configuration
 */
export function createShadowStep<TInput, TOutput>(
  stepId: string,
  executeFn: (input: TInput) => Promise<TOutput>,
  config: ShadowModeConfig,
) {
  const logger = createAuditLogger(config);
  const tier = config.tier ?? 'L1+L2+L3';
  const blockOnFailure = config.blockOnFailure ?? false;

  const breaker = new TieredCircuitBreaker({
    tier,
    l2Threshold: 0.85,
    l3ConfidenceThreshold: config.l3Threshold ?? 0.85,
    onReject: blockOnFailure ? 'abort' : 'degrade',
  });

  // Inject L2 embedding provider if L2 or L3 is enabled
  if (tier.includes('L2') || tier.includes('L3') || tier === 'auto') {
    breaker.setEmbeddingProvider(createOpenAIEmbeddingProvider({
      apiKey: config.openaiApiKey,
    }));
  }

  // Inject L3 judge if L3 is enabled
  if (tier.includes('L3') || tier === 'auto') {
    breaker.setJudgeProvider(createOpenAIJudgeProvider({
      apiKey: config.openaiApiKey,
      model: 'gpt-4o-mini',
    }));
  }

  return async function(
    input: TInput,
    traceId: string,
    runId: string,
  ): Promise<TOutput> {
    const start = Date.now();
    let output: TOutput;

    // Execute the original step
    try {
      output = await executeFn(input);
    } catch (err) {
      // Log the failure even in shadow mode
      const contract = createContract({
        fromAgent: stepId,
        traceId,
        inputs: input,
        outputs: null as any,
        constraints: [{
          description: `Step execution failed: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error',
        }],
        budget: {
          tokensUsed: 0,
          callsMade: 0,
          wallClockMs: Date.now() - start,
        },
      });

      const redacted = redactContract(contract, { sensitivityLevel: 'high' });
      logger({
        timestamp: new Date().toISOString(),
        runId,
        traceId,
        stepId,
        fromAgent: stepId,
        validation: {
          tier: 'L1',
          passed: false,
          reason: 'Step execution failed',
        },
        inputSummary: summarize(input),
        outputSummary: '[EXECUTION FAILED]',
        latencyMs: Date.now() - start,
        contract: redacted,
      });

      if (blockOnFailure) {
        throw err;
      }
      // In shadow mode, we can't continue without output, so re-throw
      throw err;
    }

    // Create State Contract
    const contract = createContract<TInput, TOutput>({
      fromAgent: stepId,
      traceId,
      inputs: input,
      outputs: output,
      budget: {
        tokensUsed: 0,
        callsMade: 0,
        wallClockMs: Date.now() - start,
      },
    });

    // Validate through Circuit Breaker
    let validation;
    try {
      validation = await breaker.validate(contract);
    } catch (err) {
      // Validation threw — log it
      validation = {
        passed: false,
        tier: 'L1',
        durationMs: Date.now() - start,
        reason: `Validation error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Redact and log
    const redacted = redactContract(contract, { sensitivityLevel: 'high' });
    logger({
      timestamp: new Date().toISOString(),
      runId,
      traceId,
      stepId,
      fromAgent: stepId,
      validation: {
        tier: validation.tier,
        passed: validation.passed,
        confidence: validation.confidence,
        reason: validation.reason,
      },
      inputSummary: summarize(input),
      outputSummary: summarize(output),
      latencyMs: Date.now() - start,
      contract: redacted,
    });

    // In shadow mode, we never block — always return the output
    return output;
  };
}

/**
 * Summarize a value for audit logging (truncates long strings/objects).
 */
function summarize(value: unknown, maxLen = 200): string {
  if (value === null || value === undefined) return '[null]';
  if (typeof value === 'string') {
    return value.length > maxLen ? value.slice(0, maxLen) + '...' : value;
  }
  const json = JSON.stringify(value);
  return json.length > maxLen ? json.slice(0, maxLen) + '...' : json;
}

/**
 * Generate a unique trace ID for a pipeline run.
 */
export function generateTraceId(): string {
  const contract = createContract({
    fromAgent: '__init__',
    inputs: {},
    outputs: {},
    budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
  });
  return contract.traceId;
}

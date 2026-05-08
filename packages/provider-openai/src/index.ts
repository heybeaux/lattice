/**
 * @heybeaux/lattice-provider-openai — OpenAI providers for Lattice.
 *
 * Provides:
 * - `createOpenAIEmbeddingProvider()` — L2 semantic consistency via text-embedding-3-small
 * - `createOpenAIJudgeProvider()` — L3 LLM-as-judge via gpt-4o-mini (configurable)
 *
 * Usage:
 * ```ts
 * import { createOpenAIEmbeddingProvider, createOpenAIJudgeProvider } from '@heybeaux/lattice-provider-openai';
 * import { TieredCircuitBreaker } from '@heybeaux/lattice-core';
 *
 * const breaker = new TieredCircuitBreaker({ tier: 'L1+L2+L3' });
 * breaker.setEmbeddingProvider(createOpenAIEmbeddingProvider());
 * breaker.setJudgeProvider(createOpenAIJudgeProvider());
 * ```
 */

import { OpenAI } from 'openai';
import type { EmbeddingProvider, JudgeProvider, JudgeResult } from '@heybeaux/lattice-core';

/**
 * Configuration for the OpenAI embedding provider.
 */
export interface OpenAIEmbeddingConfig {
  /** OpenAI API key (default: process.env.OPENAI_API_KEY) */
  apiKey?: string;
  /** Embedding model to use (default: 'text-embedding-3-small') */
  model?: string;
  /** Dimensions for the embedding (optional, model-dependent) */
  dimensions?: number;
}

/**
 * Create an L2 EmbeddingProvider using OpenAI's embedding API.
 *
 * Uses `text-embedding-3-small` by default (1536 dimensions, cost-efficient).
 *
 * @param config - OpenAI embedding configuration
 * @returns EmbeddingProvider that can be injected into TieredCircuitBreaker
 */
export function createOpenAIEmbeddingProvider(
  config?: OpenAIEmbeddingConfig,
): EmbeddingProvider {
  const client = new OpenAI({
    apiKey: config?.apiKey ?? process.env.OPENAI_API_KEY,
  });
  const model = config?.model ?? 'text-embedding-3-small';
  const dimensions = config?.dimensions;

  return {
    async embed(text: string): Promise<number[]> {
      const response = await client.embeddings.create({
        model,
        input: text,
        ...(dimensions ? { dimensions } : {}),
      });
      return response.data[0].embedding;
    },

    similarity(a: number[], b: number[]): number {
      return cosineSimilarity(a, b);
    },
  };
}

/**
 * Configuration for the OpenAI judge provider.
 */
export interface OpenAIJudgeConfig {
  /** OpenAI API key (default: process.env.OPENAI_API_KEY) */
  apiKey?: string;
  /** Model to use for judgment (default: 'gpt-4o-mini') */
  model?: string;
  /** Temperature for the judge (default: 0 — deterministic evaluation) */
  temperature?: number;
  /** Max tokens for the judge response (default: 200) */
  maxTokens?: number;
}

/**
 * System prompt for the LLM-as-judge.
 *
 * The judge evaluates whether an output actually addresses the task,
 * considering the contract context (decisions, constraints, assumptions).
 */
const JUDGE_SYSTEM_PROMPT = `You are an impartial evaluation judge for AI agent outputs.
Your job is to determine whether an agent's output actually addresses the given task.

Evaluate on these criteria:
1. **Task completion** — Does the output address the core requirements of the task?
2. **Factual consistency** — Does the output contradict known facts from the input context?
3. **Completeness** — Does the output leave obvious gaps or skip required elements?

Respond with a JSON object containing:
- "verdict": "pass", "fail", or "uncertain"
- "confidence": a number between 0 and 1
- "reasoning": a brief explanation of your judgment (1-2 sentences)

Guidelines:
- Use "pass" only if the output clearly addresses the task
- Use "fail" if the output is clearly wrong, irrelevant, or contradicts the input
- Use "uncertain" if the output is partially correct but ambiguous
- Be strict on factual consistency — hallucinations are failures
- Do not grade style, only substance`;

/**
 * Create an L3 JudgeProvider using OpenAI's chat completions API.
 *
 * Uses `gpt-4o-mini` by default (fast, cost-efficient, good at structured evaluation).
 * For higher-quality judging, use `gpt-4o` in the config.
 *
 * @param config - OpenAI judge configuration
 * @returns JudgeProvider that can be injected into TieredCircuitBreaker
 */
export function createOpenAIJudgeProvider(
  config?: OpenAIJudgeConfig,
): JudgeProvider {
  const client = new OpenAI({
    apiKey: config?.apiKey ?? process.env.OPENAI_API_KEY,
  });
  const model = config?.model ?? 'gpt-4o-mini';
  const temperature = config?.temperature ?? 0;
  const maxTokens = config?.maxTokens ?? 200;

  return {
    async judge(
      task: string,
      output: string,
      contractContext: string,
    ): Promise<JudgeResult> {
      const userPrompt = `## Task
${task}

## Output to Evaluate
${output}

## Contract Context
${contractContext}

Evaluate the output against the task. Respond with JSON only:
{"verdict": "pass"|"fail"|"uncertain", "confidence": 0.0-1.0, "reasoning": "..."}`;

      try {
        const response = await client.chat.completions.create({
          model,
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: JUDGE_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          return {
            verdict: 'uncertain',
            confidence: 0,
            reasoning: 'Judge returned empty response',
          };
        }

        try {
          const result = JSON.parse(content);
          return {
            verdict: result.verdict ?? 'uncertain',
            confidence: result.confidence ?? 0.5,
            reasoning: result.reasoning ?? '',
          };
        } catch {
          return {
            verdict: 'uncertain',
            confidence: 0,
            reasoning: `Judge returned invalid JSON: ${content.slice(0, 200)}`,
          };
        }
      } catch (error) {
        return {
          verdict: 'uncertain',
          confidence: 0,
          reasoning: `Judge API error: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Compute cosine similarity between two vectors.
 * Exported for testing.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: got ${a.length} and ${b.length}`,
    );
  }

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dotProduct / (magA * magB);
}

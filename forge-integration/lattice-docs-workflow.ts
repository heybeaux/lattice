/**
 * Lattice Documentation Generator — Forge Workflow (FIXED)
 * 
 * Generates Lattice documentation content through Forge's multi-agent pipeline:
 * Research → Outline → Draft → Review → Format
 * 
 * Each step is wrapped with Lattice shadow mode to collect benchmark data.
 * Every handoff produces a State Contract, gets validated through L1/L2/L3,
 * and is logged to the JSONL audit file — WITHOUT blocking Forge's execution.
 * 
 * USAGE:
 * 1. Copy this file to: src/mastra/workflows/lattice-docs.ts
 * 2. Copy shadow-mode.ts to: src/lattice/shadow-mode.ts
 * 3. Install deps: npm install @heybeaux/lattice-core @heybeaux/lattice-provider-openai
 * 4. Register the workflow in your Mastra instance
 * 5. Run with topics from lattice-docs-topics.json
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { createShadowStep, generateTraceId } from '../../lattice/shadow-mode';

// ─── Configuration ──────────────────────────────────────────

const LATTICE_CONTEXT = `
LATTICE PROJECT CONTEXT:
- Lattice is a TypeScript library providing coordination primitives for multi-agent AI systems
- Packages: @heybeaux/lattice-core (npm), @heybeaux/lattice-provider-openai (npm)
- GitHub: https://github.com/heybeaux/lattice
- Website: https://heybeaux.github.io/lattice/
- Core primitives: State Contracts, Circuit Breakers (L1/L2/L3), Pipeline Builder, EventEmitter, Redaction
- Real benchmark: 85% accuracy, 100% L3 detection, 0% false positives (13 tests with gpt-4o-mini)
- Target audience: AI teams building multi-agent systems who need reliability and compliance
- Positioning: "Trust infrastructure for regulated AI" — compliance/governance layer between frameworks
- Competitors: LangSmith (passive observability), LangGraph (orchestration), CrewAI (role-based teams)
- Lattice is complementary: guards the edges of any framework, doesn't replace them
`;

const LATTICE_API_DOCS = `
KEY APIS:
- createContract() — Factory for State Contracts (typed envelope with ULID, schemaVersion, traceId, inputs, decisions, outputs, constraints, assumptions, budget, metadata)
- validateContract() — L1 schema validation via Ajv (JSON Schema, <200ms)
- wrapAgent(fn, config) — Wraps any (input)=>output function with coordination
- pipeline().agent(name, fn, config).onReject(mode).build() — Sequential pipeline builder
- TieredCircuitBreaker — L1 (schema) + L2 (embedding) + L3 (LLM-as-judge) with state machine
- CircuitBreaker — Classic closed/open/half-open state machine
- EventEmitter / globalEmitter — 9 typed event types for coordination
- redactContract() — PII scrubbing (API keys, emails, phone numbers)
- createOpenAIEmbeddingProvider() — L2 via text-embedding-3-small
- createOpenAIJudgeProvider() — L3 via gpt-4o-mini (configurable)
`;

// ─── Schemas ────────────────────────────────────────────────

const docInputSchema = z.object({
  topic: z.string().describe('Documentation topic to generate'),
  docType: z.enum(['guide', 'tutorial', 'api-reference', 'blog', 'social']).describe('Type of content'),
  targetAudience: z.string().optional().describe('Target audience (e.g., "engineering managers", "compliance leads")'),
});

const researchOutputSchema = z.object({
  keyPoints: z.array(z.string()).describe('Key points to cover'),
  relatedApis: z.array(z.string()).describe('Relevant Lattice APIs to reference'),
  competitorContext: z.string().optional().describe('How this relates to competing tools'),
});

const outlineOutputSchema = z.object({
  sections: z.array(z.object({
    title: z.string(),
    subsections: z.array(z.string()).optional(),
  })),
  estimatedWordCount: z.number(),
});

const draftOutputSchema = z.object({
  title: z.string(),
  content: z.string(),
  wordCount: z.number(),
});

const reviewOutputSchema = z.object({
  passed: z.boolean(),
  score: z.number(),
  flags: z.array(z.string()),
  suggestions: z.array(z.string()),
});

// ─── Shadow mode config ────────────────────────────────────

const shadowConfig = {
  logPath: process.env.LATTICE_SHADOW_LOG ?? '/tmp/lattice-shadow-audit.jsonl',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  tier: 'L1+L2+L3' as const,
  blockOnFailure: false,
};

// ─── Original step logic (pure functions) ──────────────────

async function executeResearch(input: { topic: string; docType: string; targetAudience?: string }) {
  const agent = new Agent({
    id: 'doc-researcher',
    name: 'Documentation Researcher',
    instructions: `You are a technical researcher for Lattice documentation.

RULES:
- Only reference facts from the Lattice context provided below
- Do NOT invent APIs, features, or benchmark numbers
- Flag any gaps in the provided context
- Identify competitor comparisons where relevant

${LATTICE_CONTEXT}${LATTICE_API_DOCS}

Research the topic: "${input.topic}" (${input.docType})

Return key points to cover, relevant Lattice APIs, and competitor context.`,
    model: 'openrouter/anthropic/claude-3.5-haiku',
  });

  const result = await agent.generate([
    { role: 'user', content: `Research topic: ${input.topic}\nType: ${input.docType}\n${input.targetAudience ? `Audience: ${input.targetAudience}` : ''}` },
  ]);

  return {
    keyPoints: result.text.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, '')).slice(0, 10),
    relatedApis: [],
    competitorContext: '',
  };
}

async function executeOutline(input: { topic: string; docType: string; research: string }) {
  const agent = new Agent({
    id: 'doc-architect',
    name: 'Documentation Architect',
    instructions: `You are a documentation architect. Create a clear, logical outline.

Rules:
- Start with the user's problem, not the solution
- Progress from simple to complex
- Include code examples where applicable
- Target appropriate word count for the content type

${LATTICE_CONTEXT}

Create an outline for: "${input.topic}" (${input.docType})`,
    model: 'openrouter/anthropic/claude-3.5-haiku',
  });

  const result = await agent.generate([
    { role: 'user', content: input.research },
  ]);

  return {
    sections: [{ title: 'Introduction', subsections: [] }],
    estimatedWordCount: input.docType === 'tutorial' ? 2000 : input.docType === 'guide' ? 1500 : 800,
  };
}

async function executeDraft(input: { topic: string; docType: string; outline: string; research: string }) {
  const agent = new Agent({
    id: 'doc-drafter',
    name: 'Content Drafter',
    instructions: `You are a technical writer for Lattice documentation.

VOICE:
- Direct, no fluff
- Code examples over explanation
- Show, don't tell
- Link to API reference instead of duplicating it

RULES:
- NEVER invent APIs, features, or benchmark numbers
- Use the exact API names from the context
- Include working code examples
- Markdown format

${LATTICE_CONTEXT}${LATTICE_API_DOCS}

Write the full content for: "${input.topic}" (${input.docType})`,
    model: 'openrouter/anthropic/claude-sonnet-4-6',
  });

  const result = await agent.generate([
    { role: 'user', content: `Outline: ${input.outline}\n\nResearch: ${input.research}` },
  ]);

  return {
    title: input.topic,
    content: result.text,
    wordCount: result.text.split(/\s+/).length,
  };
}

async function executeReview(input: { draft: string; topic: string }) {
  const agent = new Agent({
    id: 'doc-reviewer',
    name: 'Documentation Reviewer',
    instructions: `You are a documentation reviewer. Evaluate the draft.

CHECKLIST:
1. Factual accuracy — no invented APIs, features, or numbers
2. Completeness — covers all key points
3. Voice — direct, no fluff, code examples
4. Structure — logical flow, appropriate for content type
5. Links — references to API reference where needed

${LATTICE_CONTEXT}

Review the draft for: "${input.topic}"

Score 0-100. Flag any issues. Suggest improvements.`,
    model: 'openrouter/anthropic/claude-sonnet-4-6',
  });

  const result = await agent.generate([
    { role: 'user', content: input.draft },
  ]);

  const text = result.text.toLowerCase();
  const hasFlags = text.includes('issue') || text.includes('fix') || text.includes('incorrect');
  
  return {
    passed: !hasFlags,
    score: hasFlags ? 70 : 90,
    flags: hasFlags ? ['Needs revision'] : [],
    suggestions: [],
  };
}

async function executeFormat(input: { content: string; docType: string; metadata?: { title: string; docType: string; wordCount: number } }) {
  const frontmatter = `---
title: "${input.metadata?.title ?? 'Untitled'}"
type: ${input.docType}
---

`;
  return {
    formattedContent: frontmatter + input.content,
    metadata: {
      title: input.metadata?.title ?? 'Untitled',
      docType: input.docType,
      wordCount: input.content.split(/\s+/).length,
    },
  };
}

// ─── Shadow-wrapped step factories ─────────────────────────

function createResearchStep() {
  const wrappedExecute = createShadowStep(
    'doc-research',
    executeResearch,
    shadowConfig,
  );

  return createStep({
    id: 'doc-research',
    description: 'Researches the topic against Lattice documentation and competitor context',
    inputSchema: docInputSchema,
    outputSchema: researchOutputSchema,
    execute: async ({ inputData }) => {
      const traceId = generateTraceId();
      const runId = `lattice-docs-${Date.now()}`;
      return wrappedExecute(inputData, traceId, runId);
    },
  });
}

function createOutlineStep() {
  const wrappedExecute = createShadowStep(
    'doc-outline',
    executeOutline,
    shadowConfig,
  );

  return createStep({
    id: 'doc-outline',
    description: 'Creates a structured outline from research',
    inputSchema: z.object({
      topic: z.string(),
      docType: z.string(),
      research: z.string(),
    }),
    outputSchema: outlineOutputSchema,
    execute: async ({ inputData }) => {
      const traceId = generateTraceId();
      const runId = `lattice-docs-${Date.now()}`;
      return wrappedExecute(inputData, traceId, runId);
    },
  });
}

function createDraftStep() {
  const wrappedExecute = createShadowStep(
    'doc-drafter',
    executeDraft,
    shadowConfig,
  );

  return createStep({
    id: 'doc-drafter',
    description: 'Writes the full content from the outline',
    inputSchema: z.object({
      topic: z.string(),
      docType: z.string(),
      outline: z.string(),
      research: z.string(),
    }),
    outputSchema: draftOutputSchema,
    execute: async ({ inputData }) => {
      const traceId = generateTraceId();
      const runId = `lattice-docs-${Date.now()}`;
      return wrappedExecute(inputData, traceId, runId);
    },
  });
}

function createReviewStep() {
  const wrappedExecute = createShadowStep(
    'doc-reviewer',
    executeReview,
    shadowConfig,
  );

  return createStep({
    id: 'doc-reviewer',
    description: 'Reviews the draft for accuracy, completeness, and voice',
    inputSchema: z.object({
      draft: z.string(),
      topic: z.string(),
    }),
    outputSchema: reviewOutputSchema,
    execute: async ({ inputData }) => {
      const traceId = generateTraceId();
      const runId = `lattice-docs-${Date.now()}`;
      return wrappedExecute(inputData, traceId, runId);
    },
  });
}

function createFormatStep() {
  const wrappedExecute = createShadowStep(
    'doc-formatter',
    executeFormat,
    shadowConfig,
  );

  return createStep({
    id: 'doc-formatter',
    description: 'Formats the reviewed draft for publication',
    inputSchema: z.object({
      content: z.string(),
      docType: z.string(),
      metadata: z.object({
        title: z.string(),
        docType: z.string(),
        wordCount: z.number(),
      }).optional(),
    }),
    outputSchema: z.object({
      formattedContent: z.string(),
      metadata: z.object({
        title: z.string(),
        docType: z.string(),
        wordCount: z.number(),
      }),
    }),
    execute: async ({ inputData }) => {
      const traceId = generateTraceId();
      const runId = `lattice-docs-${Date.now()}`;
      return wrappedExecute(inputData, traceId, runId);
    },
  });
}

// ─── Workflow ───────────────────────────────────────────────

export const latticeDocWorkflow = createWorkflow({
  id: 'lattice-doc-gen',
  inputSchema: docInputSchema,
  outputSchema: z.object({
    content: z.string(),
    metadata: z.object({
      title: z.string(),
      docType: z.string(),
      wordCount: z.number(),
    }),
  }),
})
  .then(createResearchStep())
  .then(createOutlineStep())
  .then(createDraftStep())
  .then(createReviewStep())
  .then(createFormatStep);

latticeDocWorkflow.commit();

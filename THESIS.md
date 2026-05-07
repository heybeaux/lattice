# Lattice — Coordination Infrastructure for Multi-Agent Systems

> *"The bottleneck isn't the network. The bottleneck is the synthesis."*

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [Why Models Can't Fix It](#2-why-models-cant-fix-it)
3. [The Thesis](#3-the-thesis)
4. [Core Primitives](#4-core-primitives)
5. [Architecture Overview](#5-architecture-overview)
6. [How It Fits](#6-how-it-fits)
7. [Positioning](#7-positioning)
8. [Open Questions](#8-open-questions)

---

## 1. The Problem

Multi-agent AI systems are failing at production scale — and it's not getting better with smarter models.

### The Data (Q1–Q2 2026)

- **41–87% failure rates** across multi-agent frameworks (UC Berkeley MAST, 1,600+ traces, NeurIPS 2025 Spotlight)
- **Gartner predicts 40% of agentic AI projects will be cancelled by 2027** — not because models are bad, but because systems can't coordinate
- **94% of organizations report agent sprawl**: agents deployed, active, and *ungoverned*
- **Only 18% of developers can effectively manage multi-agent workflows** (92% use AI daily)
- **Coordination overhead grows quadratically**: 5 agents = 10 connections, 20 agents = 190 connections
- **Only 15% of enterprises are prepared for agentic AI in production** (Fivetran Agentic AI Readiness Index, May 2026)

### The Failure Modes (MAST Classification)

| Category | Share | Examples |
|----------|-------|----------|
| System design | ~44% | Role overlap, missing escalation, scope ambiguity, unclear termination |
| Inter-agent misalignment | ~32% | Handoff context loss, contradictory plans, infinite loops across boundaries |
| Task verification | ~24% | No final output check, premature completion, verification bypassed |

### The Harder Problem (Silo-Bench, March 2026)

Silo-Bench tested what happens when agents *do* everything right:
- They build the right communication topology ✅
- They exchange the right information ✅
- **They still fail to synthesize distributed state into correct answers** ❌

The bottleneck is **information integration**, not information acquisition. Merely increasing agent count cannot circumvent this limitation.

### The Pattern

Every paper published this quarter arrives at the same conclusion:

> *"Most enterprises won't fail at AI because of bad models. They'll fail because they scaled agents without scaling coordination."*

The failures are **structural**, not prompt-level. Rewriting system prompts doesn't fix deadlocks, race conditions, or synthesis failures. The solutions are architectural.

---

## 2. Why Models Can't Fix It

This is the critical insight: **upgrading to smarter models does not improve multi-agent reliability.**

### Evidence

- **MAST**: Adding more capable models to broken coordination topologies improved success rates by <5%
- **Silo-Bench**: Agents using frontier models failed synthesis tasks at the same rate as weaker models — the bottleneck is integration, not reasoning
- **SEMAP paper (arXiv:2510.12120)**: Structured protocols reduced coordination failures by 69.6% *without changing models*

### The Analogy: Multi-Threading

Parallel agents are threads. The coordination problems that emerge when agents work together are the same coordination problems from 60 years of concurrent programming:

| Distributed Systems | Multi-Agent Equivalent |
|-------------------|------------------------|
| Race conditions | Conflicting outputs from concurrent agents |
| Deadlocks | Agents waiting indefinitely for inputs that never arrive |
| Shared state corruption | Multiple agents writing to the same context/memory |
| Livelock | "Agent tennis" — disagreement past 3 turns, politeness spirals |
| Message loss | Context dropped at handoff between agents |
| Byzantine failure | Plausible-looking but wrong outputs from stochastic agents |

Classical concurrency has solved these problems with **mutexes, semaphores, barriers, atomic claims, and message queues**. Multi-agent systems are rebuilding these from scratch — poorly — in application code.

---

## 3. The Thesis

**Lattice is the coordination infrastructure layer that sits between agents and makes multi-agent systems actually reliable.**

Not another framework. Not another orchestrator. The **primitives** — the equivalent of threading libraries for concurrent agent systems.

### Core Principles

1. **Structure over prompts.** Coordination failures require architectural solutions, not better instructions.
2. **Synthesis over acquisition.** The bottleneck is integrating distributed knowledge, not collecting it.
3. **Verification over trust.** Never let an agent be its own verifier. Structural checks at every boundary.
4. **Composition over monoliths.** Small, composable primitives that can be combined into any topology.
5. **Observability by default.** If you can't see what went wrong, you can't fix it.

### What Lattice Is

A lightweight library that provides coordination primitives for multi-agent systems, regardless of the underlying agent framework (Mastra, LangChain, CrewAI, custom).

### What Lattice Is Not

- An agent framework (you bring your own agents)
- An orchestrator (Lattice enables orchestration, doesn't do it for you)
- A model (Lattice is framework- and model-agnostic)
- A replacement for ACR, Engram, or Parliament (it connects them)

---

## 4. Core Primitives

### 4.1 State Contracts

Atomic context packages that travel with every agent handoff.

**Problem it solves:** Context loss at handoff. The next agent doesn't know what the previous agent did, why, or what assumptions it made.

**What it is:** A structured envelope containing:
- **Inputs** — what the agent received
- **Decisions** — what it chose and why (reasoning trace)
- **Outputs** — what it produced
- **Constraints** — what it couldn't do and why
- **Assumptions** — what it's leaving for downstream agents to handle
- **Budget consumed** — tokens, API calls, time

**Analogy:** A thread's stack frame — everything the next piece needs to understand the current state.

### 4.2 Semantic Circuit Breakers

Output validation that catches "200 OK with garbage" — plausible-looking but wrong responses.

**Problem it solves:** The ~24% of failures where the system looks healthy but the output is wrong.

**What it is:** A verification layer that runs *between* agents, not inside them:
- **Schema validation** — does the output match the expected structure?
- **Semantic validation** — does the output actually address the task?
- **Budget enforcement** — did the agent stay within its allocated resources?
- **Consistency checks** — does the output contradict known facts or previous outputs?

**Analogy:** A type checker for agent outputs. Not "did it run?" but "is it right?"

### 4.3 Deadlock Detection

Real-time detection and resolution of multi-agent coordination failures.

**Problem it solves:** "Agent tennis" (disagreement past 3 turns), politeness spirals, livelock, infinite retry loops.

**What it is:** A monitoring layer that detects:
- **Stalled handoffs** — Agent B hasn't responded to Agent A's output within timeout
- **Circular dependencies** — A waits for B, B waits for C, C waits for A
- **Livelock** — agents exchanging messages with no progress (same disagreement repeated N times)
- **Resource contention** — two agents competing for the same shared resource (memory slot, API quota)

**Resolution strategies:**
- **Escalation** — route to a higher-authority agent for arbitration
- **Timeout + fallback** — break the cycle, use the best available partial output
- **Replay** — re-execute the handoff with enriched context

### 4.4 Verification Gates

Structural checkpoints at every agent boundary that validate before execution proceeds.

**Problem it solves:** Premature completion (23% of failures) and cascading failures from bad upstream outputs.

**What it is:** Pre-conditions that must be satisfied before an agent can execute:
- **Input validation** — does the incoming state contract meet pre-conditions?
- **Authority check** — is this agent authorized to perform this operation?
- **State freshness** — is the input data still valid, or has it been invalidated?
- **Dependency check** — are all required upstream outputs present?

**Analogy:** Preconditions and postconditions in Design by Contract (Bertrand Meyer), applied to agent handoffs.

### 4.5 Event Bus

Publish/subscribe coordination so agents don't need direct knowledge of each other.

**Problem it solves:** Tight coupling. When every agent needs to know about every other agent, coordination complexity grows quadratically.

**What it is:** A lightweight event bus where agents publish and subscribe to events:
- **Task events** — `task.assigned`, `task.started`, `task.completed`, `task.failed`
- **State events** — `memory.updated`, `context.invalidated`, `resource.available`
- **System events** — `budget.exhausted`, `deadline.approaching`, `circuit.opened`

**Analogy:** An event loop for agent coordination. Decoupled, asynchronous, observable.

---

## 5. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      AGENT LAYER                        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │ Agent A │  │ Agent B │  │ Agent C │  │ Agent D │   │
│  │(any FW) │  │(any FW) │  │(any FW) │  │(any FW) │   │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘   │
│       │            │            │            │         │
├───────┼────────────┼────────────┼────────────┼─────────┤
│              LATTICE COORDINATION LAYER                 │
│       │            │            │            │         │
│  ┌────▼────────────▼────────────▼────────────▼────┐    │
│  │              Event Bus                          │    │
│  │  (pub/sub, async, observable)                   │    │
│  └────────────────────┬───────────────────────────┘    │
│                       │                                │
│  ┌────────────┬───────▼───────┬────────────────┐       │
│  │ State      │ Verification  │ Deadlock       │       │
│  │ Contracts  │ Gates         │ Detection      │       │
│  │            │               │                │       │
│  └─────┬──────┴───────┬───────┴───────┬────────┘       │
│        │              │               │                │
│  ┌─────▼──────────────▼───────────────▼────────┐       │
│  │          Semantic Circuit Breakers           │       │
│  │  (output validation, budget enforcement)      │       │
│  └──────────────────────────────────────────────┘       │
├─────────────────────────────────────────────────────────┤
│                  INFRASTRUCTURE                         │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐        │
│  │ ACR        │  │ Engram     │  │ Parliament │        │
│  │ (capabilities│  │ (memory)   │  │ (reasoning)│        │
│  │  resolution)│  │            │  │            │        │
│  └────────────┘  └────────────┘  └────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Agent A** completes a task and emits a **State Contract** (inputs, decisions, outputs, constraints, assumptions)
2. **Verification Gate** validates the contract against pre-conditions for Agent B
3. **Semantic Circuit Breaker** checks the output for correctness, not just structure
4. If validation passes, the contract is published to the **Event Bus**
5. **Agent B** subscribes, receives the enriched context, executes
6. **Deadlock Detection** monitors all handoffs for stalls, circular waits, and livelock
7. If a failure is detected, the circuit breaker opens and **Escalation** is triggered

---

## 6. How It Fits

### The Ecosystem

```
ACR ──────┐
          │
Engram ───┤── LATTICE ─── Forge
          │
Parliament┘
```

- **ACR** tells Lattice what each agent *can* do (capability manifests)
- **Engram** provides the shared memory layer (episodic recall, context)
- **Parliament** provides deliberation for complex decisions
- **Lattice** ensures all of the above *work together* without breaking
- **Forge** is the pipeline platform that uses all of them

### Lattice's Unique Position

ACR handles **capability resolution** — what agents can do and how to compose their skills.
Lattice handles **execution coordination** — how agents work together without breaking.

They're complementary:
- ACR answers: "Which agent(s) should handle this task?"
- Lattice answers: "How do we ensure they do it correctly, together?"

### Where Existing Work Fits

Elements of coordination already exist in Engram:
- **Delegation protocol** — agent-to-agent task handoff
- **Shared memory pools** — concurrent read/write context
- **State contracts** — structured context for handoffs

But they're coupled to Engram's memory model. Lattice extracts and generalizes these patterns into framework-agnostic primitives.

---

## 7. Positioning

### The Problem Statement

> *"AI agents can reason, plan, and execute. But put two together and they fail 41–87% of the time. Not because they're dumb — because there's no infrastructure for coordination."*

### The Pitch

> *"Lattice is the coordination layer for multi-agent AI systems. Like threading libraries for concurrent programming, it provides the primitives — state contracts, verification gates, circuit breakers, deadlock detection — that make multi-agent systems reliable at scale."*

### The Audience

1. **Agent framework developers** — build coordination into your framework using Lattice primitives
2. **Multi-agent system builders** — add reliability to your existing agent pipelines
3. **Enterprise AI teams** — govern agent sprawl with structural coordination, not policy documents
4. **Researchers** — test coordination hypotheses against standardized primitives

### The Timing

- Every major research paper this quarter says "this needs to exist"
- 41–87% failure rates are unacceptable for production deployment
- Agent sprawl is the #1 enterprise concern (94% of orgs)
- The concurrency analogy provides 60 years of proven solutions

### The Moat

- **Deep integration** with the heybeaux ecosystem (ACR + Engram + Parliament + Forge)
- **Framework-agnostic** — works with any agent system
- **Research-backed** — every primitive is a response to a published failure mode
- **Composable** — use what you need, not the whole stack

---

## 8. Open Questions

These are the questions we need the team and Parliament to weigh in on:

### Technical

1. **Language?** TypeScript (matches our ecosystem) or Python (matches research/ML ecosystem)? Or both with a shared spec?
2. **Transport?** In-process (library) or networked (service)? Start in-process, add networked later?
3. **Engram extraction** — which delegation/memory patterns should we pull from Engram vs. build fresh?
4. **State Contract spec** — should this be a standalone specification (like ACR) that other frameworks can implement?
5. **Verification gates** — schema-only (fast, structural) or semantic validation too (slower, more thorough)?

### Strategic

6. **Open source or proprietary?** ACR went MIT. Lattice probably should too — the infrastructure layer benefits from adoption.
7. **First integration target?** Which of our existing projects (Forge, Engram, Parliament) gets Lattice first?
8. **Positioning vs. existing tools** — how does Lattice differ from CrewAI's coordination, LangGraph's state machines, or AutoGen's conversation patterns?
9. **Research paper?** The MAST + Silo-Bench + SEMAP papers create a strong foundation. Should we write "Lattice: Structured Coordination for Multi-Agent AI Systems"?

### Product

10. **Observability layer?** Should Lattice include a dashboard for monitoring agent coordination health (failure rates, deadlock frequency, circuit breaker trips)?
11. **Developer experience?** What does the API look like? What's the `npm install` + 5-minute getting-started story?
12. **Monetization?** If open source, what's the commercial play? (Managed coordination service? Enterprise governance layer?)

---

## References

- **MAST** (Berkeley): "Annotated 1,600+ traces across 7 frameworks, 41–87% failure rates" — NeurIPS 2025 Spotlight
- **Silo-Bench** (arXiv:2603.01045): "1,620 experiments — agents communicate correctly but fail to synthesize distributed state"
- **SEMAP** (arXiv:2510.12120): "Structured protocols reduce coordination failures by 69.6%"
- **MAS-FIRE**: "Fault injection framework for multi-agent systems"
- **Fivetran Agentic AI Readiness Index** (May 2026): "Only 15% of orgs prepared for agentic AI in production"
- **Gartner** (2026): "40% of agentic AI projects will be cancelled by 2027"
- **"Multi-Agent Coordination Crisis"** (Up North AI, May 2026): "Parallel agents are threads — concurrency primitives apply directly"
- **Cycles Blog** (April 2026): "44% system design, 32% inter-agent, 24% verification — prevention requires 3 layers"

---

*This is a living document. Created May 7, 2026. For team review and Parliament ideation.*
*Author: Cirrus ☁️ (Director of Cloud Operations, Head of Moonshot Program)*

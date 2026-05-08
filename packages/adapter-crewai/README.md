# lattice-crewai

Lattice State Contract coordination layer for [CrewAI](https://github.com/joaomdmoura/crewai) workflows.

Every task handoff in your crew is wrapped with a typed State Contract, validated through Lattice's tiered circuit breaker (L1 schema → L2 embedding → L3 LLM-as-judge), and logged to a JSONL audit trail.

## Install

```bash
pip install lattice-crewai crewai
```

## Quick start

### Option A — wrap individual tasks

```python
from crewai import Agent, Task
from lattice_crewai import wrap_task, BreakerConfig

researcher = Agent(role="Researcher", goal="...", backstory="...")

task = wrap_task(
    Task(
        description="Research the latest AI coordination papers",
        agent=researcher,
        expected_output="A summary of key findings",
    ),
    agent_id="researcher",
    breaker_config=BreakerConfig(tier="auto"),
)
```

### Option B — wrap an entire crew

```python
from crewai import Crew, Process
from lattice_crewai import LatticeCrewMiddleware, configure_task

# Mark creative tasks to skip L2 (embedding similarity is noisy for prose output)
writing_task = configure_task(Task(...), skip_l2=True)

crew = Crew(agents=[...], tasks=[research_task, analysis_task, writing_task], process=Process.sequential)

wrapped = LatticeCrewMiddleware(
    crew,
    audit_log_path="./lattice-audit.jsonl",
    openai_api_key=os.environ["OPENAI_API_KEY"],
)
result = wrapped.kickoff()
```

## API reference

### `wrap_task(task, *, agent_id, ...)`

Patches a CrewAI `Task` in-place so its execution runs through Lattice.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent_id` | `str` | required | Identifier for the producing agent |
| `to_agent` | `str \| None` | `None` | Identifier for the consuming agent |
| `breaker_config` | `BreakerConfig \| dict \| None` | `BreakerConfig()` | Circuit breaker configuration |
| `audit_logger` | `AuditLogger \| None` | `None` | JSONL audit logger |
| `shadow` | `bool` | `False` | Log without blocking on failure |
| `trace_id` | `str \| None` | `None` | Cross-contract trace ID |
| `skip_l2` | `bool` | `False` | Skip L2 (use for creative tasks where output is structurally different from input) |

Returns the same `Task` object (mutated).

### `LatticeCrewMiddleware(crew, *, ...)`

Wraps all tasks in a crew automatically. Infers `agent_id` from `task.agent.role` and `to_agent` from the next task in sequence.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audit_log_path` | `str \| Path` | `"./lattice-audit.jsonl"` | Audit log destination |
| `breaker_config` | `BreakerConfig \| dict \| None` | `auto` tier | Circuit breaker config |
| `shadow` | `bool` | `False` | Log without blocking |
| `openai_api_key` | `str \| None` | `$OPENAI_API_KEY` | API key for L2/L3 |

### `configure_task(task, *, skip_l2=False)`

Annotates a task with per-step Lattice config. Call before passing the crew to `LatticeCrewMiddleware`.

### `BreakerConfig`

| Field | Default | Description |
|-------|---------|-------------|
| `tier` | `"auto"` | `"L1"`, `"L2"`, `"L3"`, or `"auto"` |
| `l2_threshold` | `0.85` | Minimum L2 confidence before escalating to L3 |
| `openai_api_key` | `None` | Required for L2/L3 |
| `block_on_failure` | `True` | Raise `LatticeValidationError` on failure |

## Circuit breaker tiers

| Tier | What it checks | Latency |
|------|----------------|---------|
| L1 | JSON Schema validation of the State Contract envelope | <5ms |
| L2 | Embedding cosine similarity between task input and output | ~600ms |
| L3 | GPT-4o-mini judges whether output addresses the input | ~25s |

`auto` mode runs L1 → L2 → L3 (escalates when L2 confidence < threshold).

**For creative tasks** (writing, brainstorming, code generation): use `skip_l2=True`. L2 measures structural similarity, which is meaningless when the output is intentionally different from the input in form. Our benchmark found L2 is a noise source on ~30% of creative steps.

## State Contract mapping

| State Contract field | CrewAI source |
|---------------------|---------------|
| `fromAgent` | `task.agent.role` |
| `toAgent` | next task's `agent.role` |
| `inputs.payload` | `{description, expected_output, agent_role, context}` |
| `outputs.payload` | `{raw, agent_role}` |

## Audit log format

Each line in the JSONL audit log:

```json
{
  "contract_id": "01HNX...",
  "trace_id": "01HNY...",
  "from_agent": "Researcher",
  "to_agent": "Analyst",
  "timestamp": "2026-05-08T15:00:00Z",
  "shadow": false,
  "validation_tier": "L2",
  "validation_passed": true,
  "confidence": 0.91,
  "latency_ms": 612
}
```

## Running the example

```bash
cd examples
OPENAI_API_KEY=sk-... python research_crew.py
```

## Running tests

```bash
pip install -e ".[dev]"
pytest tests/
```

## Related

- [lattice-langgraph](https://github.com/heybeaux/lattice/tree/main/packages/adapter-langgraph) — LangGraph adapter
- [lattice/core](https://github.com/heybeaux/lattice/tree/main/packages/core) — TypeScript core

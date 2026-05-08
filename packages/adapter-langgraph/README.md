# lattice-langgraph

Lattice coordination layer for [LangGraph](https://github.com/langchain-ai/langgraph) workflows.

Wraps LangGraph nodes with **State Contracts** and **Circuit Breakers** — every handoff becomes a typed, validated, auditable envelope.

## Install

```bash
pip install lattice-langgraph
```

## Quick start

### Option A — wrap individual nodes

```python
from lattice_langgraph import wrap_node, BreakerConfig
from langgraph.graph import StateGraph, END
from typing import TypedDict

class State(TypedDict):
    topic: str
    result: str

def researcher(state):
    return {"result": f"findings about {state['topic']}"}

def writer(state):
    return {"result": f"article: {state['result']}"}

graph = StateGraph(State)
graph.add_node("researcher", wrap_node(researcher, agent_id="researcher", to_agent="writer"))
graph.add_node("writer", wrap_node(writer, agent_id="writer"))
graph.set_entry_point("researcher")
graph.add_edge("researcher", "writer")
graph.add_edge("writer", END)

app = graph.compile()
result = app.invoke({"topic": "quantum computing"})
```

### Option B — wrap the whole graph with `LatticeMiddleware`

```python
from lattice_langgraph import LatticeMiddleware
import os

# Build your graph normally
graph = StateGraph(State)
graph.add_node("researcher", researcher)
graph.add_node("writer", writer)
graph.set_entry_point("researcher")
graph.add_edge("researcher", "writer")
graph.add_edge("writer", END)
compiled = graph.compile()

# Wrap it
app = LatticeMiddleware(
    compiled,
    audit_log_path="./lattice-audit.jsonl",
    openai_api_key=os.environ["OPENAI_API_KEY"],
)
result = app.invoke({"topic": "quantum computing"})
```

## Validation tiers

| Tier | What | When | Latency |
|------|------|------|---------|
| L1 | JSON Schema validation | Always | <200ms |
| L2 | Embedding similarity | On every handoff | ~500ms |
| L3 | LLM-as-judge (gpt-4o-mini) | L2 similarity < 0.85 or high-risk edge | 1–3s |
| auto | L1 always, L2 always, L3 on escalation | Default | varies |

```python
from lattice_langgraph import BreakerConfig

# L1 only (fast, no LLM calls)
config = BreakerConfig(tier="L1")

# Full auto (L1+L2, escalate to L3 on low confidence)
config = BreakerConfig(tier="auto", openai_api_key="sk-...")

# Shadow mode — log without blocking
wrapped = wrap_node(my_node, agent_id="agent", shadow=True, breaker_config=config)
```

## Shadow mode

Shadow mode logs every handoff without blocking graph execution. Use this to collect production data before enabling enforcement:

```python
app = LatticeMiddleware(graph, shadow=True, audit_log_path="./audit.jsonl")
```

The audit log is JSONL. Each line:

```json
{
  "contract_id": "01HXZ...",
  "trace_id": "01HXZ...",
  "from_agent": "researcher",
  "to_agent": "writer",
  "timestamp": "2026-05-08T...",
  "shadow": false,
  "validation_tier": "L1",
  "validation_passed": true,
  "confidence": 1.0,
  "latency_ms": 12
}
```

## State Contract schema

Every handoff produces a `StateContract`:

```python
from lattice_langgraph import create_contract

contract = create_contract(
    from_agent="researcher",
    inputs={"topic": "climate"},
    outputs={"findings": "..."},
    to_agent="writer",
)
print(contract.to_dict())
```

The schema is JSON Schema 2020-12 (same as `@heybeaux/lattice-core`). See [`contract.schema.json`](src/lattice_langgraph/contract.schema.json).

## API reference

### `wrap_node(node_fn, *, agent_id, to_agent=None, breaker_config=None, audit_logger=None, shadow=False, trace_id=None)`

Wraps a LangGraph node function. Returns a drop-in replacement with the same `(state: dict) -> dict` signature.

### `LatticeMiddleware(graph, *, audit_log_path, breaker_config=None, shadow=False, openai_api_key=None)`

Wraps a compiled LangGraph graph. Delegates `.invoke()`, `.ainvoke()`, `.stream()` to the underlying graph after patching all nodes.

### `BreakerConfig`

| Field | Default | Description |
|-------|---------|-------------|
| `tier` | `"auto"` | `"L1"`, `"L2"`, `"L3"`, or `"auto"` |
| `l2_threshold` | `0.85` | Confidence below which L3 is triggered |
| `openai_api_key` | `None` | Falls back to `OPENAI_API_KEY` env var |
| `block_on_failure` | `True` | Raise `LatticeValidationError` on failure |

## Benchmark results

From the Lattice benchmark suite (real OpenAI API calls):

- **100%** hallucination detection (6/6 caught by L3)
- **0%** false positive rate (4/4 correct outputs passed)
- **0** false negatives
- L1 latency: <200ms
- L3 latency: 1–3s (only on escalation)

## Example

See [`examples/research_pipeline.py`](examples/research_pipeline.py) for a complete 4-node research graph using both `wrap_node` and `LatticeMiddleware`.

```bash
OPENAI_API_KEY=sk-... python examples/research_pipeline.py
```

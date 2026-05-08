"""
Example: 4-node research pipeline wrapped with Lattice.

Graph: planner -> researcher -> writer -> reviewer

Run:
    pip install lattice-langgraph langgraph langchain-core
    OPENAI_API_KEY=sk-... python examples/research_pipeline.py
"""

import os
from typing import TypedDict

from langgraph.graph import END, StateGraph

from lattice_langgraph import BreakerConfig, LatticeMiddleware, wrap_node


class ResearchState(TypedDict):
    topic: str
    plan: str
    research: str
    draft: str
    review: str


# --- Node definitions ---

def planner_node(state: ResearchState) -> dict:
    topic = state["topic"]
    return {"plan": f"Research plan for '{topic}': 1) gather sources 2) synthesize 3) draft 4) review"}


def researcher_node(state: ResearchState) -> dict:
    plan = state["plan"]
    topic = state["topic"]
    return {
        "research": (
            f"Key findings on '{topic}': "
            "Source A suggests X. Source B corroborates with Y. "
            "Consensus: the evidence supports Z."
        )
    }


def writer_node(state: ResearchState) -> dict:
    research = state["research"]
    topic = state["topic"]
    return {
        "draft": (
            f"# {topic.title()}\n\n"
            f"Based on recent research:\n\n{research}\n\n"
            "In conclusion, the evidence is clear and warrants further investigation."
        )
    }


def reviewer_node(state: ResearchState) -> dict:
    draft = state["draft"]
    return {
        "review": f"Review passed. The draft covers the topic with adequate sourcing. Word count: {len(draft.split())}."
    }


# --- Option A: wrap individual nodes ---

def build_wrapped_graph_individual() -> StateGraph:
    breaker = BreakerConfig(tier="L1")  # L1-only for fast local demo

    graph = StateGraph(ResearchState)
    graph.add_node("planner", wrap_node(planner_node, agent_id="planner", to_agent="researcher", breaker_config=breaker))
    graph.add_node("researcher", wrap_node(researcher_node, agent_id="researcher", to_agent="writer", breaker_config=breaker))
    graph.add_node("writer", wrap_node(writer_node, agent_id="writer", to_agent="reviewer", breaker_config=breaker))
    graph.add_node("reviewer", wrap_node(reviewer_node, agent_id="reviewer", breaker_config=breaker))

    graph.set_entry_point("planner")
    graph.add_edge("planner", "researcher")
    graph.add_edge("researcher", "writer")
    graph.add_edge("writer", "reviewer")
    graph.add_edge("reviewer", END)
    return graph.compile()


# --- Option B: LatticeMiddleware wraps the whole graph ---

def build_wrapped_graph_middleware() -> LatticeMiddleware:
    graph = StateGraph(ResearchState)
    graph.add_node("planner", planner_node)
    graph.add_node("researcher", researcher_node)
    graph.add_node("writer", writer_node)
    graph.add_node("reviewer", reviewer_node)

    graph.set_entry_point("planner")
    graph.add_edge("planner", "researcher")
    graph.add_edge("researcher", "writer")
    graph.add_edge("writer", "reviewer")
    graph.add_edge("reviewer", END)

    compiled = graph.compile()
    return LatticeMiddleware(
        compiled,
        audit_log_path="./lattice-audit.jsonl",
        breaker_config=BreakerConfig(
            tier="auto",
            openai_api_key=os.environ.get("OPENAI_API_KEY"),
        ),
        shadow=False,
    )


if __name__ == "__main__":
    print("=== Option A: wrap_node() per node ===")
    graph_a = build_wrapped_graph_individual()
    result_a = graph_a.invoke({"topic": "climate change adaptation strategies"})
    print("Review:", result_a["review"])
    print()

    print("=== Option B: LatticeMiddleware ===")
    graph_b = build_wrapped_graph_middleware()
    result_b = graph_b.invoke({"topic": "quantum computing in drug discovery"})
    print("Review:", result_b["review"])
    print("Audit log written to ./lattice-audit.jsonl")

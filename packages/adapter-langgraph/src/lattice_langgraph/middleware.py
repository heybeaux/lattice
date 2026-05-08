from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .audit import AuditLogger
from .breaker import BreakerConfig
from .wrapper import wrap_node


class LatticeMiddleware:
    """
    Wraps an entire compiled LangGraph graph (or StateGraph before compilation)
    so every invoke() call runs all nodes through Lattice coordination.

    Usage:
        graph = StateGraph(MyState)
        # ... add nodes and edges ...
        compiled = graph.compile()
        wrapped = LatticeMiddleware(compiled, audit_log_path="./lattice-audit.jsonl")
        result = wrapped.invoke({"topic": "climate change"})
    """

    def __init__(
        self,
        graph: Any,
        *,
        audit_log_path: str | Path = "./lattice-audit.jsonl",
        breaker_config: BreakerConfig | dict | None = None,
        shadow: bool = False,
        openai_api_key: str | None = None,
    ) -> None:
        self._graph = graph
        self._shadow = shadow
        self._audit = AuditLogger(audit_log_path)

        if isinstance(breaker_config, dict):
            breaker_config = BreakerConfig(**breaker_config)

        if breaker_config is None:
            api_key = openai_api_key or os.environ.get("OPENAI_API_KEY")
            breaker_config = BreakerConfig(tier="auto", openai_api_key=api_key)

        self._breaker_config = breaker_config
        self._wrap_graph_nodes()

    def _wrap_graph_nodes(self) -> None:
        """Patch each node in the compiled graph's node map in-place."""
        nodes = getattr(self._graph, "nodes", None)
        if nodes is None:
            return

        for node_id, node_data in nodes.items():
            if node_id in ("__start__", "__end__"):
                continue
            runnable = getattr(node_data, "runnable", None) or node_data
            if callable(runnable) and not getattr(runnable, "_lattice_wrapped", False):
                wrapped = wrap_node(
                    runnable,
                    agent_id=node_id,
                    breaker_config=self._breaker_config,
                    audit_logger=self._audit,
                    shadow=self._shadow,
                )
                wrapped._lattice_wrapped = True  # type: ignore[attr-defined]
                if hasattr(node_data, "runnable"):
                    node_data.runnable = wrapped
                else:
                    nodes[node_id] = wrapped

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
        return self._graph.invoke(input, config, **kwargs)

    async def ainvoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
        return await self._graph.ainvoke(input, config, **kwargs)

    def stream(self, input: Any, config: Any = None, **kwargs: Any):
        return self._graph.stream(input, config, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._graph, name)

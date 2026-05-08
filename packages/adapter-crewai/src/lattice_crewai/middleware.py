from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .audit import AuditLogger
from .breaker import BreakerConfig
from .wrapper import wrap_task


class LatticeCrewMiddleware:
    """Wraps an entire CrewAI Crew so every task runs through Lattice coordination.

    Usage:
        crew = Crew(agents=[...], tasks=[...], process=Process.sequential)
        wrapped = LatticeCrewMiddleware(crew, audit_log_path="./lattice-audit.jsonl")
        result = wrapped.kickoff()
    """

    def __init__(
        self,
        crew: Any,
        *,
        audit_log_path: str | Path = "./lattice-audit.jsonl",
        breaker_config: BreakerConfig | dict | None = None,
        shadow: bool = False,
        openai_api_key: str | None = None,
    ) -> None:
        self._crew = crew
        self._shadow = shadow
        self._audit = AuditLogger(audit_log_path)

        if isinstance(breaker_config, dict):
            breaker_config = BreakerConfig(**breaker_config)

        if breaker_config is None:
            api_key = openai_api_key or os.environ.get("OPENAI_API_KEY")
            breaker_config = BreakerConfig(tier="auto", openai_api_key=api_key)

        self._breaker_config = breaker_config
        self._wrap_crew_tasks()

    def _wrap_crew_tasks(self) -> None:
        tasks = getattr(self._crew, "tasks", [])
        for i, task in enumerate(tasks):
            if getattr(task, "_lattice_wrapped", False):
                continue

            agent = getattr(task, "agent", None)
            agent_id = getattr(agent, "role", f"task_{i}") if agent else f"task_{i}"

            next_task = tasks[i + 1] if i + 1 < len(tasks) else None
            next_agent = getattr(next_task, "agent", None) if next_task else None
            to_agent = getattr(next_agent, "role", None) if next_agent else None

            # Per-step config: respect skip_l2 metadata if set on the task
            skip_l2 = getattr(task, "_lattice_skip_l2", False)

            wrap_task(
                task,
                agent_id=agent_id,
                to_agent=to_agent,
                breaker_config=self._breaker_config,
                audit_logger=self._audit,
                shadow=self._shadow,
                skip_l2=skip_l2,
            )

    def kickoff(self, inputs: dict | None = None) -> Any:
        return self._crew.kickoff(inputs=inputs)

    async def kickoff_async(self, inputs: dict | None = None) -> Any:
        return await self._crew.kickoff_async(inputs=inputs)

    def kickoff_for_each(self, inputs: list[dict]) -> list[Any]:
        return self._crew.kickoff_for_each(inputs=inputs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._crew, name)


def configure_task(task: Any, *, skip_l2: bool = False) -> Any:
    """Annotate a CrewAI Task with per-step Lattice configuration.

    Call before passing the crew to LatticeCrewMiddleware.

        task = configure_task(Task(...), skip_l2=True)
    """
    task._lattice_skip_l2 = skip_l2
    return task

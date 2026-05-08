from __future__ import annotations

import time
from typing import Any

from .audit import AuditLogger
from .breaker import BreakerConfig, run_circuit_breaker
from .contract import create_contract, StateContract


class LatticeValidationError(Exception):
    def __init__(self, message: str, contract: StateContract) -> None:
        super().__init__(message)
        self.contract = contract


def wrap_task(
    task: Any,
    *,
    agent_id: str,
    to_agent: str | None = None,
    breaker_config: BreakerConfig | dict | None = None,
    audit_logger: AuditLogger | None = None,
    shadow: bool = False,
    trace_id: str | None = None,
    skip_l2: bool = False,
) -> Any:
    """Wrap a CrewAI Task with Lattice State Contract coordination.

    Patches task.execute_sync in-place so the crew's kickoff() flow
    automatically runs every handoff through the circuit breaker.
    Returns the same Task object (mutated), so it drops in anywhere
    a plain Task would be used.
    """
    if isinstance(breaker_config, dict):
        breaker_config = BreakerConfig(**breaker_config)
    config = breaker_config or BreakerConfig()

    if skip_l2 and config.tier == "auto":
        config = BreakerConfig(
            tier="L3",
            openai_api_key=config.openai_api_key,
            block_on_failure=config.block_on_failure,
        )

    original_execute = task.execute_sync

    def patched_execute_sync(agent: Any = None, context: str | None = None, tools: list | None = None) -> Any:
        task_input = {
            "description": task.description,
            "expected_output": task.expected_output,
            "agent_role": getattr(agent or task.agent, "role", agent_id),
            "context": context,
        }

        t0 = time.monotonic()
        output = original_execute(agent=agent, context=context, tools=tools)
        wall_ms = int((time.monotonic() - t0) * 1000)

        task_output = {
            "raw": getattr(output, "raw", str(output)),
            "agent_role": getattr(agent or task.agent, "role", agent_id),
        }

        contract = create_contract(
            from_agent=agent_id,
            inputs=task_input,
            outputs=task_output,
            trace_id=trace_id,
            to_agent=to_agent,
            wall_clock_ms=wall_ms,
        )

        validation = run_circuit_breaker(
            contract.to_dict(),
            task_input,
            task_output,
            config=config,
        )

        if audit_logger:
            audit_logger.log(
                contract,
                validation_tier=validation.tier,
                validation_passed=validation.passed,
                confidence=validation.confidence,
                latency_ms=validation.latency_ms,
                shadow=shadow,
            )

        if not shadow and not validation.passed and config.block_on_failure:
            raise LatticeValidationError(
                f"[Lattice] {agent_id} failed {validation.tier}: {validation.reason}",
                contract,
            )

        return output

    task.execute_sync = patched_execute_sync
    task._lattice_wrapped = True
    task._lattice_agent_id = agent_id
    return task

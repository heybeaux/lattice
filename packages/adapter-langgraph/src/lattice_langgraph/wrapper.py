from __future__ import annotations

import time
from typing import Any, Callable, TypeVar

from .audit import AuditLogger
from .breaker import BreakerConfig, run_circuit_breaker
from .contract import StateContract, create_contract

StateDict = dict[str, Any]
NodeFunc = Callable[[StateDict], StateDict]


class LatticeValidationError(Exception):
    def __init__(self, message: str, contract: StateContract) -> None:
        super().__init__(message)
        self.contract = contract


def wrap_node(
    node_fn: NodeFunc,
    *,
    agent_id: str,
    to_agent: str | None = None,
    breaker_config: BreakerConfig | dict | None = None,
    audit_logger: AuditLogger | None = None,
    shadow: bool = False,
    trace_id: str | None = None,
) -> NodeFunc:
    """Wrap a LangGraph node function with Lattice State Contract coordination."""
    if isinstance(breaker_config, dict):
        breaker_config = BreakerConfig(**breaker_config)
    config = breaker_config or BreakerConfig()

    def wrapped(state: StateDict) -> StateDict:
        t0 = time.monotonic()
        output = node_fn(state)
        wall_ms = int((time.monotonic() - t0) * 1000)

        result_state = {**state, **(output or {})}
        contract = create_contract(
            from_agent=agent_id,
            inputs=state,
            outputs=result_state,
            trace_id=trace_id,
            to_agent=to_agent,
            wall_clock_ms=wall_ms,
        )

        validation = run_circuit_breaker(
            contract.to_dict(),
            state,
            result_state,
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

        return output or {}

    wrapped.__name__ = f"lattice_{agent_id}"
    wrapped.__wrapped__ = node_fn  # type: ignore[attr-defined]
    return wrapped

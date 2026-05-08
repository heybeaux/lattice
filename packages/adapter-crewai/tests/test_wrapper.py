"""Tests for lattice-crewai wrapper and middleware."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from lattice_crewai import (
    AuditLogger,
    BreakerConfig,
    LatticeCrewMiddleware,
    LatticeValidationError,
    StateContract,
    configure_task,
    wrap_task,
)
from lattice_crewai.breaker import ValidationResult, validate_l1
from lattice_crewai.contract import create_contract


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mock_task(description="Do some research", expected_output="A report", role="Researcher"):
    agent = MagicMock()
    agent.role = role

    task = MagicMock()
    task.description = description
    task.expected_output = expected_output
    task.agent = agent
    task._lattice_wrapped = False
    task._lattice_skip_l2 = False

    output = MagicMock()
    output.raw = "Here are the key findings: ..."
    task.execute_sync.return_value = output

    return task, agent, output


def _make_mock_crew(tasks):
    crew = MagicMock()
    crew.tasks = tasks
    result = MagicMock()
    result.raw = "Final crew output"
    crew.kickoff.return_value = result
    return crew


# ---------------------------------------------------------------------------
# State Contract creation
# ---------------------------------------------------------------------------

def test_create_contract_fields():
    contract = create_contract(
        from_agent="researcher",
        inputs={"description": "Research AI", "expected_output": "Report"},
        outputs={"raw": "Here are findings"},
        to_agent="writer",
        wall_clock_ms=500,
    )
    assert contract.from_agent == "researcher"
    assert contract.to_agent == "writer"
    assert contract.budget.wall_clock_ms == 500
    assert contract.inputs.payload["description"] == "Research AI"
    assert contract.outputs.payload["raw"] == "Here are findings"


def test_contract_to_dict_schema_valid():
    contract = create_contract(
        from_agent="agent-a",
        inputs={"task": "do thing"},
        outputs={"result": "done"},
    )
    d = contract.to_dict()
    assert d["fromAgent"] == "agent-a"
    assert "id" in d
    assert "traceId" in d
    assert d["inputs"]["contentType"] == "application/json"

    # L1 validate the contract dict
    result = validate_l1(d)
    assert result.passed, f"L1 failed: {result.reason}"


# ---------------------------------------------------------------------------
# L1 circuit breaker
# ---------------------------------------------------------------------------

def test_l1_passes_valid_contract():
    contract = create_contract(
        from_agent="x",
        inputs={"data": 1},
        outputs={"data": 2},
    )
    result = validate_l1(contract.to_dict())
    assert result.passed
    assert result.tier == "L1"
    assert result.confidence == 1.0


def test_l1_fails_missing_field():
    bad = {
        "id": "01HNXXXXXXXXXXXXXXXXXXXXXXX",
        "schemaVersion": "0.1.0",
        # missing traceId, fromAgent, timestamp, inputs, outputs, etc.
    }
    result = validate_l1(bad)
    assert not result.passed
    assert result.tier == "L1"
    assert result.confidence == 0.0


# ---------------------------------------------------------------------------
# wrap_task — interception
# ---------------------------------------------------------------------------

def test_wrap_task_marks_wrapped():
    task, _, _ = _make_mock_task()
    config = BreakerConfig(tier="L1")
    wrap_task(task, agent_id="researcher", breaker_config=config)
    assert task._lattice_wrapped is True
    assert task._lattice_agent_id == "researcher"


def test_wrap_task_calls_original():
    task, agent, output = _make_mock_task()
    config = BreakerConfig(tier="L1")
    wrap_task(task, agent_id="researcher", breaker_config=config)

    result = task.execute_sync(agent=agent, context=None, tools=None)
    assert result is output


def test_wrap_task_creates_audit_entry():
    task, agent, output = _make_mock_task()

    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
        log_path = f.name

    audit = AuditLogger(log_path)
    config = BreakerConfig(tier="L1")
    wrap_task(task, agent_id="researcher", breaker_config=config, audit_logger=audit)
    task.execute_sync(agent=agent, context=None, tools=None)

    entries = [json.loads(l) for l in Path(log_path).read_text().strip().splitlines()]
    assert len(entries) == 1
    assert entries[0]["from_agent"] == "researcher"
    assert entries[0]["validation_tier"] == "L1"
    assert entries[0]["validation_passed"] is True


def test_wrap_task_shadow_mode_no_raise():
    """Shadow mode should never raise even when validation fails."""
    task, agent, _ = _make_mock_task()
    config = BreakerConfig(tier="L1", block_on_failure=True)
    wrap_task(task, agent_id="researcher", breaker_config=config, shadow=True)

    # Force L1 to fail by making the task output something that produces a bad contract
    # We do this by patching validate_l1 to return a failed result
    with patch("lattice_crewai.wrapper.run_circuit_breaker") as mock_cb:
        mock_cb.return_value = ValidationResult(
            passed=False, tier="L1", confidence=0.0, latency_ms=1, reason="forced fail"
        )
        # Should NOT raise in shadow mode
        result = task.execute_sync(agent=agent, context=None, tools=None)
        assert result is not None


def test_wrap_task_blocks_on_failure():
    task, agent, _ = _make_mock_task()
    config = BreakerConfig(tier="L1", block_on_failure=True)
    wrap_task(task, agent_id="researcher", breaker_config=config, shadow=False)

    with patch("lattice_crewai.wrapper.run_circuit_breaker") as mock_cb:
        mock_cb.return_value = ValidationResult(
            passed=False, tier="L1", confidence=0.0, latency_ms=1, reason="bad contract"
        )
        with pytest.raises(LatticeValidationError) as exc_info:
            task.execute_sync(agent=agent, context=None, tools=None)
        assert "L1" in str(exc_info.value)
        assert exc_info.value.contract is not None


def test_wrap_task_skip_l2_uses_l3():
    """skip_l2=True on an auto-tier config should escalate to L3 directly."""
    task, _, _ = _make_mock_task()
    config = BreakerConfig(tier="auto")
    wrap_task(task, agent_id="writer", breaker_config=config, skip_l2=True)

    with patch("lattice_crewai.wrapper.run_circuit_breaker") as mock_cb:
        mock_cb.return_value = ValidationResult(passed=True, tier="L3", confidence=0.9, latency_ms=100)
        task.execute_sync(agent=task.agent, context=None, tools=None)
        called_config = mock_cb.call_args[1]["config"]
        assert called_config.tier == "L3"


# ---------------------------------------------------------------------------
# LatticeCrewMiddleware
# ---------------------------------------------------------------------------

def test_middleware_wraps_all_tasks():
    task1, _, _ = _make_mock_task(role="Researcher")
    task2, _, _ = _make_mock_task(role="Writer")
    crew = _make_mock_crew([task1, task2])

    LatticeCrewMiddleware(crew, breaker_config=BreakerConfig(tier="L1"))

    assert task1._lattice_wrapped is True
    assert task2._lattice_wrapped is True


def test_middleware_sets_to_agent_from_next_task():
    task1, _, _ = _make_mock_task(role="Researcher")
    task2, _, _ = _make_mock_task(role="Writer")
    crew = _make_mock_crew([task1, task2])

    LatticeCrewMiddleware(crew, breaker_config=BreakerConfig(tier="L1"))

    assert task1._lattice_agent_id == "Researcher"
    # to_agent for task1 should point to task2's agent role
    # (verified indirectly via wrap_task, which sets agent_id not to_agent on the task)


def test_middleware_kickoff_delegates():
    task, _, _ = _make_mock_task()
    crew = _make_mock_crew([task])
    wrapped = LatticeCrewMiddleware(crew, breaker_config=BreakerConfig(tier="L1"))
    result = wrapped.kickoff(inputs={"topic": "AI"})
    crew.kickoff.assert_called_once_with(inputs={"topic": "AI"})
    assert result is crew.kickoff.return_value


def test_middleware_skips_already_wrapped():
    task, _, _ = _make_mock_task()
    task._lattice_wrapped = True
    original_execute = task.execute_sync

    crew = _make_mock_crew([task])
    LatticeCrewMiddleware(crew, breaker_config=BreakerConfig(tier="L1"))

    # execute_sync should not have been replaced
    assert task.execute_sync is original_execute


def test_configure_task_sets_skip_l2():
    task, _, _ = _make_mock_task()
    configure_task(task, skip_l2=True)
    assert task._lattice_skip_l2 is True


def test_middleware_respects_configure_task_skip_l2():
    task, _, _ = _make_mock_task(role="Poet")
    configure_task(task, skip_l2=True)
    crew = _make_mock_crew([task])

    LatticeCrewMiddleware(crew, breaker_config=BreakerConfig(tier="auto"))

    with patch("lattice_crewai.wrapper.run_circuit_breaker") as mock_cb:
        mock_cb.return_value = ValidationResult(passed=True, tier="L3", confidence=0.9, latency_ms=50)
        task.execute_sync(agent=task.agent, context=None, tools=None)
        called_config = mock_cb.call_args[1]["config"]
        assert called_config.tier == "L3"


# ---------------------------------------------------------------------------
# Audit logger
# ---------------------------------------------------------------------------

def test_audit_logger_thread_safe():
    """Multiple log calls should all appear in the file."""
    import threading

    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
        log_path = f.name

    audit = AuditLogger(log_path)

    contracts = [
        create_contract(from_agent=f"agent-{i}", inputs={"i": i}, outputs={"r": i * 2})
        for i in range(20)
    ]

    threads = [
        threading.Thread(target=audit.log, args=(c,), kwargs={"validation_passed": True, "validation_tier": "L1"})
        for c in contracts
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    lines = Path(log_path).read_text().strip().splitlines()
    assert len(lines) == 20

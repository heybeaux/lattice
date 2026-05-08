import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from lattice_langgraph import (
    AuditLogger,
    BreakerConfig,
    LatticeValidationError,
    StateContract,
    create_contract,
    wrap_node,
)
from lattice_langgraph.breaker import validate_l1


# --- StateContract tests ---

def test_create_contract_basic():
    c = create_contract(
        from_agent="planner",
        inputs={"topic": "climate"},
        outputs={"plan": "research plan"},
    )
    assert c.from_agent == "planner"
    assert c.inputs.payload == {"topic": "climate"}
    assert c.outputs.payload == {"plan": "research plan"}
    assert len(c.id) == 26
    assert len(c.trace_id) == 26
    assert c.schema_version == "0.1.0"


def test_create_contract_with_trace_id():
    c = create_contract(
        from_agent="a",
        inputs={},
        outputs={},
        trace_id="01HXYZ1234567890ABCDEFGHIJ",
    )
    assert c.trace_id == "01HXYZ1234567890ABCDEFGHIJ"


def test_contract_to_dict_structure():
    c = create_contract(from_agent="a", inputs={"x": 1}, outputs={"y": 2})
    d = c.to_dict()
    required_keys = {
        "id", "schemaVersion", "traceId", "parentIds", "fromAgent",
        "toAgent", "timestamp", "inputs", "outputs", "decisions",
        "constraints", "assumptions", "budget", "metadata",
    }
    assert required_keys == set(d.keys())
    assert d["inputs"]["payload"] == {"x": 1}
    assert d["outputs"]["payload"] == {"y": 2}


# --- L1 validation tests ---

def test_l1_validates_correct_contract():
    c = create_contract(from_agent="agent", inputs={"q": "hello"}, outputs={"a": "world"})
    result = validate_l1(c.to_dict())
    assert result.passed is True
    assert result.tier == "L1"
    assert result.latency_ms >= 0


def test_l1_rejects_missing_required_field():
    c = create_contract(from_agent="agent", inputs={}, outputs={})
    d = c.to_dict()
    del d["fromAgent"]
    result = validate_l1(d)
    assert result.passed is False
    assert "fromAgent" in result.reason


def test_l1_rejects_extra_properties():
    c = create_contract(from_agent="agent", inputs={}, outputs={})
    d = c.to_dict()
    d["unknownField"] = "oops"
    result = validate_l1(d)
    assert result.passed is False


# --- wrap_node tests ---

def make_node(return_val: dict):
    def node(state):
        return return_val
    return node


def test_wrap_node_passes_output_through():
    node = make_node({"result": "done"})
    wrapped = wrap_node(node, agent_id="test", breaker_config=BreakerConfig(tier="L1"))
    output = wrapped({"input": "hello"})
    assert output == {"result": "done"}


def test_wrap_node_preserves_node_name():
    node = make_node({})
    wrapped = wrap_node(node, agent_id="my_agent", breaker_config=BreakerConfig(tier="L1"))
    assert "my_agent" in wrapped.__name__


def test_wrap_node_shadow_mode_does_not_raise_on_failure():
    bad_node = make_node({})

    def always_fail_l1(contract_dict, inputs, outputs, *, config):
        from lattice_langgraph.breaker import ValidationResult
        return ValidationResult(passed=False, tier="L1", confidence=0.0, latency_ms=0, reason="forced fail")

    with patch("lattice_langgraph.wrapper.run_circuit_breaker", always_fail_l1):
        wrapped = wrap_node(
            bad_node,
            agent_id="shadow_agent",
            shadow=True,
            breaker_config=BreakerConfig(tier="L1"),
        )
        output = wrapped({"state": "ok"})
        assert output == {}


def test_wrap_node_blocks_on_failure_by_default():
    node = make_node({})

    def always_fail(contract_dict, inputs, outputs, *, config):
        from lattice_langgraph.breaker import ValidationResult
        return ValidationResult(passed=False, tier="L1", confidence=0.0, latency_ms=0, reason="bad output")

    with patch("lattice_langgraph.wrapper.run_circuit_breaker", always_fail):
        wrapped = wrap_node(node, agent_id="strict_agent", breaker_config=BreakerConfig(tier="L1", block_on_failure=True))
        with pytest.raises(LatticeValidationError) as exc_info:
            wrapped({"x": 1})
        assert "strict_agent" in str(exc_info.value)


def test_wrap_node_no_block_when_disabled():
    node = make_node({"out": 1})

    def always_fail(contract_dict, inputs, outputs, *, config):
        from lattice_langgraph.breaker import ValidationResult
        return ValidationResult(passed=False, tier="L1", confidence=0.0, latency_ms=0, reason="x")

    with patch("lattice_langgraph.wrapper.run_circuit_breaker", always_fail):
        wrapped = wrap_node(
            node,
            agent_id="lenient",
            breaker_config=BreakerConfig(tier="L1", block_on_failure=False),
        )
        output = wrapped({"state": "x"})
        assert output == {"out": 1}


# --- AuditLogger tests ---

def test_audit_logger_writes_jsonl():
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
        path = f.name

    try:
        logger = AuditLogger(path)
        c = create_contract(from_agent="a", inputs={"x": 1}, outputs={"y": 2})
        logger.log(c, validation_tier="L1", validation_passed=True, confidence=1.0, latency_ms=5)

        with open(path) as f:
            lines = f.readlines()

        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["from_agent"] == "a"
        assert entry["validation_tier"] == "L1"
        assert entry["validation_passed"] is True
        assert entry["confidence"] == 1.0
    finally:
        os.unlink(path)


def test_audit_logger_multiple_entries():
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
        path = f.name

    try:
        logger = AuditLogger(path)
        for i in range(3):
            c = create_contract(from_agent=f"agent_{i}", inputs={}, outputs={})
            logger.log(c)

        with open(path) as f:
            lines = f.readlines()

        assert len(lines) == 3
    finally:
        os.unlink(path)

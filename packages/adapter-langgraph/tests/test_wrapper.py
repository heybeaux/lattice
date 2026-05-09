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


# --- Issue #27 / FINDING-009 — fail-closed on L2/L3 provider errors ---


def test_l2_fails_closed_on_openai_import_error():
    """If OpenAI SDK or numpy aren't importable, L2 must NOT pass."""
    with patch.dict("sys.modules", {"openai": None}):
        from lattice_langgraph.breaker import validate_l2

        result = validate_l2({"q": "x"}, {"a": "y"}, openai_api_key="anything")
        assert result.passed is False
        assert result.tier == "L2"
        assert "L2 provider error" in result.reason


def test_l3_fails_closed_on_openai_import_error():
    with patch.dict("sys.modules", {"openai": None}):
        from lattice_langgraph.breaker import validate_l3

        result = validate_l3({"q": "x"}, {"a": "y"}, openai_api_key="anything")
        assert result.passed is False
        assert result.tier == "L3"
        assert "L3 provider error" in result.reason


def test_l3_clamps_attacker_supplied_confidence():
    """A judge response with confidence=999 must be clamped to 1.0,
    not trusted verbatim — defense-in-depth alongside the TS provider fix."""
    from lattice_langgraph.breaker import validate_l3

    fake_response = type(
        "R",
        (),
        {
            "choices": [
                type(
                    "C",
                    (),
                    {
                        "message": type(
                            "M",
                            (),
                            {"content": '{"passed": true, "confidence": 999, "reason": "x"}'},
                        )()
                    },
                )()
            ]
        },
    )()

    class FakeOpenAI:
        def __init__(self, **_):
            self.chat = type("C", (), {"completions": type("X", (), {"create": lambda self, **kw: fake_response})()})()

    with patch("openai.OpenAI", FakeOpenAI):
        r = validate_l3({"q": "x"}, {"a": "y"}, openai_api_key="anything")
        assert r.passed is True
        assert r.confidence == 1.0


def test_l3_rejects_non_bool_passed_field():
    """If the judge returns passed: 'yes' (string), treat it as False."""
    from lattice_langgraph.breaker import validate_l3

    fake_response = type(
        "R",
        (),
        {
            "choices": [
                type(
                    "C",
                    (),
                    {
                        "message": type(
                            "M",
                            (),
                            {"content": '{"passed": "yes", "confidence": 1, "reason": "x"}'},
                        )()
                    },
                )()
            ]
        },
    )()

    class FakeOpenAI:
        def __init__(self, **_):
            self.chat = type("C", (), {"completions": type("X", (), {"create": lambda self, **kw: fake_response})()})()

    with patch("openai.OpenAI", FakeOpenAI):
        r = validate_l3({"q": "x"}, {"a": "y"}, openai_api_key="anything")
        assert r.passed is False


def test_run_circuit_breaker_l2_failure_blocks_in_default_mode():
    """End-to-end: L2 provider error → wrapper raises by default."""
    from lattice_langgraph import BreakerConfig
    from lattice_langgraph.breaker import ValidationResult

    def fake_l2(*a, **kw):
        return ValidationResult(passed=False, tier="L2", confidence=0.0, latency_ms=1, reason="L2 provider error: bad creds")

    with patch("lattice_langgraph.breaker.validate_l2", fake_l2):
        node = make_node({})
        wrapped = wrap_node(
            node,
            agent_id="net_blocked",
            breaker_config=BreakerConfig(tier="L2", openai_api_key="invalid"),
        )
        with pytest.raises(LatticeValidationError) as exc:
            wrapped({"x": 1})
        assert "L2 provider error" in str(exc.value)


def test_run_circuit_breaker_l3_failure_blocks_in_default_mode():
    from lattice_langgraph import BreakerConfig
    from lattice_langgraph.breaker import ValidationResult

    def fake_l3(*a, **kw):
        return ValidationResult(passed=False, tier="L3", confidence=0.0, latency_ms=1, reason="L3 provider error: net down")

    with patch("lattice_langgraph.breaker.validate_l3", fake_l3):
        node = make_node({})
        wrapped = wrap_node(
            node,
            agent_id="judge_blocked",
            breaker_config=BreakerConfig(tier="L3", openai_api_key="invalid"),
        )
        with pytest.raises(LatticeValidationError):
            wrapped({"x": 1})


def test_l2_failure_passes_through_when_block_on_failure_is_false():
    """Explicit opt-in to non-blocking mode: validation runs, logs the
    failure, but does not raise. Use this for staged rollouts where you
    want to monitor L2/L3 health without affecting graph execution."""
    from lattice_langgraph import BreakerConfig
    from lattice_langgraph.breaker import ValidationResult

    def fake_l2(*a, **kw):
        return ValidationResult(passed=False, tier="L2", confidence=0.0, latency_ms=1, reason="degraded")

    with patch("lattice_langgraph.breaker.validate_l2", fake_l2):
        node = make_node({"out": 1})
        wrapped = wrap_node(
            node,
            agent_id="degraded_node",
            breaker_config=BreakerConfig(tier="L2", block_on_failure=False),
        )
        output = wrapped({"x": 1})  # must NOT raise
        assert output == {"out": 1}


def test_l2_failure_does_not_block_when_shadow_mode():
    """Shadow mode: validation runs (and is logged), never blocks."""
    from lattice_langgraph import BreakerConfig
    from lattice_langgraph.breaker import ValidationResult

    def fake_l2(*a, **kw):
        return ValidationResult(passed=False, tier="L2", confidence=0.0, latency_ms=1, reason="degraded")

    with patch("lattice_langgraph.breaker.validate_l2", fake_l2):
        node = make_node({"out": 2})
        wrapped = wrap_node(
            node,
            agent_id="shadow_node",
            shadow=True,
            breaker_config=BreakerConfig(tier="L2"),
        )
        output = wrapped({"x": 1})
        assert output == {"out": 2}


def test_l2_provider_error_is_logged():
    """Verify provider errors surface through the logging module so
    operators can monitor degraded validation health."""
    import logging

    from lattice_langgraph.breaker import validate_l2

    with patch.dict("sys.modules", {"openai": None}):
        with patch.object(logging.getLogger("lattice_langgraph.breaker"), "warning") as mock_warning:
            result = validate_l2({"q": 1}, {"a": 2}, openai_api_key="x")
            assert result.passed is False
            assert mock_warning.called


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

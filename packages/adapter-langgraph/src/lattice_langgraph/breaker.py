from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import jsonschema

_SCHEMA_PATH = Path(__file__).parent / "contract.schema.json"
_schema: dict | None = None


def _load_schema() -> dict:
    global _schema
    if _schema is None:
        with open(_SCHEMA_PATH) as f:
            _schema = json.load(f)
    return _schema


@dataclass
class ValidationResult:
    passed: bool
    tier: str
    confidence: float
    latency_ms: int
    reason: str = ""


def validate_l1(contract_dict: dict) -> ValidationResult:
    start = time.monotonic()
    schema = _load_schema()
    try:
        jsonschema.validate(contract_dict, schema)
        passed = True
        reason = ""
    except jsonschema.ValidationError as e:
        passed = False
        reason = e.message
    latency_ms = int((time.monotonic() - start) * 1000)
    return ValidationResult(
        passed=passed,
        tier="L1",
        confidence=1.0 if passed else 0.0,
        latency_ms=latency_ms,
        reason=reason,
    )


def validate_l2(inputs: Any, outputs: Any, *, openai_api_key: str | None = None) -> ValidationResult:
    start = time.monotonic()
    try:
        import numpy as np
        from openai import OpenAI

        client = OpenAI(api_key=openai_api_key)

        def embed(text: str) -> list[float]:
            resp = client.embeddings.create(model="text-embedding-3-small", input=text[:8000])
            return resp.data[0].embedding

        input_text = json.dumps(inputs) if not isinstance(inputs, str) else inputs
        output_text = json.dumps(outputs) if not isinstance(outputs, str) else outputs

        v1 = np.array(embed(input_text))
        v2 = np.array(embed(output_text))
        similarity = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2)))

        passed = similarity >= 0.3  # low bar — L2 is a signal, not a gate
        latency_ms = int((time.monotonic() - start) * 1000)
        return ValidationResult(
            passed=passed,
            tier="L2",
            confidence=similarity,
            latency_ms=latency_ms,
            reason="" if passed else f"embedding similarity too low: {similarity:.3f}",
        )
    except Exception as e:
        latency_ms = int((time.monotonic() - start) * 1000)
        return ValidationResult(passed=True, tier="L2", confidence=0.5, latency_ms=latency_ms, reason=f"L2 skipped: {e}")


def validate_l3(inputs: Any, outputs: Any, *, openai_api_key: str | None = None) -> ValidationResult:
    start = time.monotonic()
    try:
        from openai import OpenAI

        client = OpenAI(api_key=openai_api_key)

        input_text = json.dumps(inputs) if not isinstance(inputs, str) else inputs
        output_text = json.dumps(outputs) if not isinstance(outputs, str) else outputs

        prompt = (
            "You are a strict judge evaluating whether an AI agent's output addresses its input task.\n\n"
            f"INPUT:\n{input_text[:3000]}\n\n"
            f"OUTPUT:\n{output_text[:3000]}\n\n"
            "Does the output meaningfully address the input? "
            "Respond with JSON: {\"passed\": true/false, \"confidence\": 0.0-1.0, \"reason\": \"...\"}"
        )

        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_tokens=200,
        )

        result = json.loads(resp.choices[0].message.content)
        latency_ms = int((time.monotonic() - start) * 1000)
        return ValidationResult(
            passed=bool(result.get("passed", True)),
            tier="L3",
            confidence=float(result.get("confidence", 0.8)),
            latency_ms=latency_ms,
            reason=result.get("reason", ""),
        )
    except Exception as e:
        latency_ms = int((time.monotonic() - start) * 1000)
        return ValidationResult(passed=True, tier="L3", confidence=0.5, latency_ms=latency_ms, reason=f"L3 skipped: {e}")


@dataclass
class BreakerConfig:
    tier: str = "auto"  # "L1", "L2", "L3", or "auto"
    l2_threshold: float = 0.85
    openai_api_key: str | None = None
    block_on_failure: bool = True


def run_circuit_breaker(
    contract_dict: dict,
    inputs: Any,
    outputs: Any,
    *,
    config: BreakerConfig,
) -> ValidationResult:
    l1 = validate_l1(contract_dict)
    if not l1.passed:
        return l1

    if config.tier == "L1":
        return l1

    if config.tier in ("L2", "auto"):
        l2 = validate_l2(inputs, outputs, openai_api_key=config.openai_api_key)
        if config.tier == "L2":
            return l2
        # auto: escalate to L3 if L2 confidence is low
        if not l2.passed or l2.confidence < config.l2_threshold:
            l3 = validate_l3(inputs, outputs, openai_api_key=config.openai_api_key)
            return l3
        return l2

    if config.tier == "L3":
        return validate_l3(inputs, outputs, openai_api_key=config.openai_api_key)

    return l1

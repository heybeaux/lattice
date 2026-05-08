from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ulid import ULID


@dataclass
class ContractPayload:
    payload: Any
    content_type: str = "application/json"
    content_length: int = 0

    def to_dict(self) -> dict:
        return {
            "payload": self.payload,
            "contentType": self.content_type,
            "contentLength": self.content_length,
        }


@dataclass
class Decision:
    rationale: str
    type: str = "action"
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {"type": self.type, "rationale": self.rationale, "timestamp": self.timestamp}
        if self.context:
            d["context"] = self.context
        return d


@dataclass
class Constraint:
    description: str
    severity: str = "info"
    context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {"description": self.description, "severity": self.severity}
        if self.context:
            d["context"] = self.context
        return d


@dataclass
class Assumption:
    description: str
    risk_level: str = "medium"

    def to_dict(self) -> dict:
        return {"description": self.description, "riskLevel": self.risk_level}


@dataclass
class BudgetRecord:
    tokens_used: int = 0
    calls_made: int = 0
    wall_clock_ms: int = 0
    estimated_cost: float | None = None

    def to_dict(self) -> dict:
        d = {
            "tokensUsed": self.tokens_used,
            "callsMade": self.calls_made,
            "wallClockMs": self.wall_clock_ms,
        }
        if self.estimated_cost is not None:
            d["estimatedCost"] = self.estimated_cost
        return d


@dataclass
class StateContract:
    from_agent: str
    inputs: ContractPayload
    outputs: ContractPayload
    id: str = field(default_factory=lambda: str(ULID()))
    schema_version: str = "0.1.0"
    trace_id: str = field(default_factory=lambda: str(ULID()))
    parent_ids: list[str] = field(default_factory=list)
    to_agent: str | None = None
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    decisions: list[Decision] = field(default_factory=list)
    constraints: list[Constraint] = field(default_factory=list)
    assumptions: list[Assumption] = field(default_factory=list)
    budget: BudgetRecord = field(default_factory=BudgetRecord)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "schemaVersion": self.schema_version,
            "traceId": self.trace_id,
            "parentIds": self.parent_ids,
            "fromAgent": self.from_agent,
            "toAgent": self.to_agent,
            "timestamp": self.timestamp,
            "inputs": self.inputs.to_dict(),
            "outputs": self.outputs.to_dict(),
            "decisions": [d.to_dict() for d in self.decisions],
            "constraints": [c.to_dict() for c in self.constraints],
            "assumptions": [a.to_dict() for a in self.assumptions],
            "budget": self.budget.to_dict(),
            "metadata": self.metadata,
        }


def _payload_size(data: Any) -> int:
    try:
        return len(json.dumps(data).encode())
    except Exception:
        return 0


def create_contract(
    from_agent: str,
    inputs: Any,
    outputs: Any,
    *,
    trace_id: str | None = None,
    to_agent: str | None = None,
    parent_ids: list[str] | None = None,
    wall_clock_ms: int = 0,
    metadata: dict[str, Any] | None = None,
) -> StateContract:
    contract = StateContract(
        from_agent=from_agent,
        to_agent=to_agent,
        inputs=ContractPayload(
            payload=inputs,
            content_type="application/json",
            content_length=_payload_size(inputs),
        ),
        outputs=ContractPayload(
            payload=outputs,
            content_type="application/json",
            content_length=_payload_size(outputs),
        ),
        parent_ids=parent_ids or [],
        budget=BudgetRecord(wall_clock_ms=wall_clock_ms),
        metadata=metadata or {},
    )
    if trace_id:
        contract.trace_id = trace_id
    return contract

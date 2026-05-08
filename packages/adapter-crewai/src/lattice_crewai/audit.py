from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import Any

from .contract import StateContract


class AuditLogger:
    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._lock = Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def log(
        self,
        contract: StateContract,
        *,
        validation_tier: str | None = None,
        validation_passed: bool | None = None,
        confidence: float | None = None,
        latency_ms: int | None = None,
        shadow: bool = False,
    ) -> None:
        entry: dict[str, Any] = {
            "contract_id": contract.id,
            "trace_id": contract.trace_id,
            "from_agent": contract.from_agent,
            "to_agent": contract.to_agent,
            "timestamp": contract.timestamp,
            "shadow": shadow,
        }
        if validation_tier is not None:
            entry["validation_tier"] = validation_tier
        if validation_passed is not None:
            entry["validation_passed"] = validation_passed
        if confidence is not None:
            entry["confidence"] = confidence
        if latency_ms is not None:
            entry["latency_ms"] = latency_ms

        with self._lock:
            with open(self._path, "a") as f:
                f.write(json.dumps(entry) + "\n")

# Lattice Config Reference

Lattice auto-discovers a configuration file from your working directory on startup. No environment variable or code change needed — just drop a file and go.

## Supported Formats

| File | Parser | Notes |
|------|--------|-------|
| `lattice.config.json` | Built-in | Fastest. Use `createConfig()` (sync). |
| `lattice.config.yaml` / `.yml` | [js-yaml](https://github.com/nodeca/js-yaml) | Requires `npm install js-yaml`. Use `createConfigAsync()`. |
| `lattice.config.toml` | [toml](https://github.com/BinaryMuse/toml-node) | Requires `npm install toml`. Use `createConfigAsync()`. |
| `lattice.config.mjs` | Native ESM `import()` | Use `createConfigAsync()`. Export default. |
| `lattice.config.cjs` | `require()` | Use `createConfigAsync()`. `module.exports`. |

Discovery order is top-to-bottom in the table above. The first file found wins.

## Loading the Config

```typescript
import { createConfig, createConfigAsync } from '@heybeaux/lattice-core';

// Sync — JSON only (always available)
const config = createConfig();

// Async — all formats
const config = await createConfigAsync();

// Explicit path
const config = createConfig('./path/to/lattice.config.json');
const config = await createConfigAsync('./path/to/lattice.config.yaml');

// Programmatic override (merged on top of file config)
const config = createConfig({
  circuitBreaker: { failureThreshold: 5 },
});
```

## Full Schema Reference

All fields are optional. Omitted fields use the defaults shown below.

```typescript
interface LatticeConfig {
  circuitBreaker?: {
    /**
     * Validation tier(s) to run on each handoff.
     * - 'L1'        — JSON schema only (fastest, no external calls)
     * - 'L1+L2'     — L1 + embedding similarity (requires EmbeddingProvider)
     * - 'L1+L3'     — L1 + LLM-as-judge (requires JudgeProvider)
     * - 'L1+L2+L3'  — all three tiers
     * - 'auto'      — L1 always; L2 if EmbeddingProvider set; L3 only when L2
     *                 similarity falls below l3EscalationThreshold (default)
     * Default: 'auto'
     */
    tier?: 'L1' | 'L1+L2' | 'L1+L3' | 'L1+L2+L3' | 'auto';

    /**
     * Minimum cosine similarity for L2 to pass [0–1].
     * Default: 0.7
     */
    l2Threshold?: number;

    /**
     * Minimum confidence from LLM judge for L3 to pass [0–1].
     * Default: 0.7
     */
    l3ConfidenceThreshold?: number;

    /**
     * L2 similarity below this threshold triggers L3 escalation (auto mode).
     * Default: 0.85
     */
    l3EscalationThreshold?: number;

    /**
     * Consecutive failures before the circuit opens.
     * Default: 3
     */
    failureThreshold?: number;

    /**
     * Milliseconds to wait (open state) before transitioning to half-open.
     * Default: 60000
     */
    recoveryTimeoutMs?: number;

    /**
     * Persist circuit state across restarts.
     * Omit to disable persistence (in-memory only).
     */
    persist?: {
      /**
       * Storage backend.
       * - 'json'   — JSON file, no extra deps (default)
       * - 'sqlite' — SQLite3 (requires sqlite3 peer dep)
       */
      backend?: 'json' | 'sqlite';

      /** File path for the state file. Required. */
      path: string;

      /**
       * Debounce window for flushing writes to disk (ms).
       * Writes are batched; the file is updated at most once per window.
       * Default: 1000
       */
      syncIntervalMs?: number;
    };
  };

  observability?: {
    /**
     * Path for the JSON-line log file.
     * When set, creates a JsonLineExporter attached to globalEmitter.
     * Omit to disable file logging.
     */
    jsonLinePath?: string;

    /**
     * OpenTelemetry OTLP exporter config.
     * When set, creates an OtelExporter attached to globalEmitter.
     * Requires optional peer deps: @opentelemetry/sdk-node,
     * @opentelemetry/api, @opentelemetry/exporter-trace-otlp-http.
     * If not installed, spans are tracked internally without OTLP export.
     */
    otlpExporter?: {
      /** OTLP endpoint URL (e.g. 'http://localhost:4318/v1/traces') */
      endpoint: string;
      /** Transport protocol. Default: 'http' */
      protocol?: 'http' | 'grpc';
      /** Service name reported to the backend. Default: 'lattice' */
      serviceName?: string;
    };
  };

  audit?: {
    /**
     * Path for the compliance audit log.
     * Omit to disable audit log.
     */
    logPath?: string;

    /**
     * Days to retain audit log entries before pruning.
     * Default: 90
     */
    retentionDays?: number;

    /**
     * Hash algorithm for audit log integrity chains.
     * Default: 'sha256'
     */
    algorithm?: 'sha256' | 'sha512';
  };

  redaction?: {
    /**
     * How aggressively to redact sensitive values.
     * - 'low'    — API keys and tokens only
     * - 'medium' — API keys, tokens, and emails
     * - 'high'   — all of the above plus phone numbers and passwords
     * Default: 'high'
     */
    sensitivityLevel?: 'low' | 'medium' | 'high';

    /**
     * Additional JSON paths to always redact (dot-notation).
     * E.g. ['outputs.internalId', 'inputs.ssn']
     */
    additionalPaths?: string[];
  };
}
```

### Defaults

```typescript
{
  circuitBreaker: {
    tier: 'auto',
    l2Threshold: 0.7,
    l3ConfidenceThreshold: 0.7,
    l3EscalationThreshold: 0.85,
    failureThreshold: 3,
    recoveryTimeoutMs: 60000,
  },
  audit: {
    retentionDays: 90,
    algorithm: 'sha256',
  },
  redaction: {
    sensitivityLevel: 'high',
  },
}
```

## Examples

### `lattice.config.json`

```json
{
  "circuitBreaker": {
    "tier": "L1+L2",
    "failureThreshold": 5,
    "recoveryTimeoutMs": 30000,
    "persist": {
      "backend": "json",
      "path": "./data/circuit-state.json",
      "syncIntervalMs": 500
    }
  },
  "observability": {
    "jsonLinePath": "./logs/lattice-events.jsonl",
    "otlpExporter": {
      "endpoint": "http://localhost:4318/v1/traces",
      "serviceName": "my-agent-pipeline"
    }
  },
  "audit": {
    "logPath": "./logs/audit.jsonl",
    "retentionDays": 30
  },
  "redaction": {
    "sensitivityLevel": "high",
    "additionalPaths": ["outputs.internalId"]
  }
}
```

### `lattice.config.yaml`

```yaml
circuitBreaker:
  tier: L1+L2
  failureThreshold: 5
  recoveryTimeoutMs: 30000
  persist:
    backend: json
    path: ./data/circuit-state.json
    syncIntervalMs: 500

observability:
  jsonLinePath: ./logs/lattice-events.jsonl
  otlpExporter:
    endpoint: http://localhost:4318/v1/traces
    serviceName: my-agent-pipeline

audit:
  logPath: ./logs/audit.jsonl
  retentionDays: 30

redaction:
  sensitivityLevel: high
  additionalPaths:
    - outputs.internalId
```

### `lattice.config.mjs` (ESM)

```javascript
// lattice.config.mjs
export default {
  circuitBreaker: {
    tier: 'L1+L2',
    failureThreshold: process.env.NODE_ENV === 'production' ? 5 : 10,
    persist: {
      path: './data/circuit-state.json',
    },
  },
  observability: {
    jsonLinePath: './logs/lattice.jsonl',
  },
};
```

## Config Precedence

Lower numbers win (highest priority first):

1. **Programmatic override** — values passed directly to `createConfig({ ... })`
2. **File config** — values from the discovered (or specified) config file
3. **Defaults** — built-in defaults from `defaultConfig()`

## Validation

`createConfig()` validates the merged config and throws `ConfigValidationError` on violations:

```typescript
import { createConfig, ConfigValidationError } from '@heybeaux/lattice-core';

try {
  const config = createConfig({ circuitBreaker: { l2Threshold: 1.5 } });
} catch (err) {
  if (err instanceof ConfigValidationError) {
    console.error(err.message);  // "circuitBreaker.l2Threshold must be between 0 and 1"
    console.error(err.field);    // "circuitBreaker.l2Threshold"
    console.error(err.expected); // "0-1"
    console.error(err.actual);   // 1.5
  }
}
```

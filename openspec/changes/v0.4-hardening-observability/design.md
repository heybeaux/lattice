# Design: Lattice v0.4.0 — Hardening & Observability

## Technical Approach

### 1. Persistent Circuit State

**Storage backend:** JSON file by default, SQLite optional via peer dependency.

```typescript
// packages/core/src/breaker/persistence.ts

interface PersistenceBackend {
  getState(id: string): Promise<PersistedBreakerState | null>;
  setState(id: string, state: PersistedBreakerState): Promise<void>;
  clearState(id: string): Promise<void>;
}

class JsonFileBackend implements PersistenceBackend {
  private filePath: string;
  private cache: Map<string, PersistedBreakerState>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.cache = this.loadFromFile();
  }

  async getState(id: string): Promise<PersistedBreakerState | null> {
    return this.cache.get(id) ?? null;
  }

  async setState(id: string, state: PersistedBreakerState): Promise<void> {
    this.cache.set(id, state);
    this.writeToFile();
  }

  // Atomic write: write to temp file, then rename
  private writeToFile(): void {
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify([...this.cache.entries()], null, 2));
    renameSync(tmpPath, this.filePath);
  }
}
```

**CircuitBreaker integration:**
```typescript
class CircuitBreaker {
  private persistence?: PersistenceBackend;

  constructor(config: CircuitBreakerConfig) {
    if (config.persist) {
      this.persistence = config.persist.backend === 'sqlite'
        ? new SqliteBackend(config.persist.path)
        : new JsonFileBackend(config.persist.path);
      this.restoreState();
    }
  }

  private async restoreState(): Promise<void> {
    if (!this.persistence) return;
    const state = await this.persistence.getState(this.id);
    if (state) {
      this._state = state.state;
      this._consecutiveFailures = state.consecutiveFailures;
      // ... restore other fields
    }
  }

  private async persistState(): Promise<void> {
    if (!this.persistence) return;
    await this.persistence.setState(this.id, {
      id: this.id,
      state: this._state,
      // ... save all fields
    });
  }
}
```

### 2. L2 Embedding Integration

**EmbeddingProvider interface** (already exists in types.ts):
```typescript
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  similarity(a: number[], b: number[]): number;
}
```

**OpenAI provider with batching:**
```typescript
// packages/provider-openai/src/embedding.ts

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private queue: Array<{ text: string; resolve: (v: number[]) => void; reject: (e: Error) => void }>;
  private timer: NodeJS.Timeout | null;

  async embed(text: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      if (!this.timer) {
        this.timer = setTimeout(() => this.flushQueue(), this.batchWindowMs);
      }
    });
  }

  private async flushQueue(): Promise<void> {
    const batch = this.queue.splice(0, this.batchSize);
    const texts = batch.map(b => b.text);
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    batch.forEach((b, i) => b.resolve(response.data[i].embedding));
    this.timer = null;
  }
}
```

### 3. Structured Observability

**OpenTelemetry exporter:**
```typescript
// packages/core/src/observability/otel.ts

export class OtelExporter {
  private tracer: Tracer;

  constructor(endpoint: string, protocol: 'http' | 'grpc' = 'http') {
    // Initialize OTel SDK with endpoint
  }

  startSpan(name: string, attributes: Record<string, unknown>): Span {
    const span = this.tracer.startSpan(name, { attributes });
    return span;
  }

  endSpan(span: Span, status: 'ok' | 'error'): void {
    span.setStatus(status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR);
    span.end();
  }
}
```

**Integration with existing events:**
```typescript
// In wrapAgent / TieredCircuitBreaker
const span = otel.startSpan('lattice.contract.validate', {
  'lattice.tier': tier,
  'lattice.agent_id': agentId,
  'lattice.trace_id': traceId,
});

const result = await breaker.validate(contract);

otel.endSpan(span, result.passed ? 'ok' : 'error');
```

### 4. Config System

**Auto-discovery:**
```typescript
// packages/core/src/config/loader.ts

const CONFIG_FILES = [
  'lattice.config.js',
  'lattice.config.yaml',
  'lattice.config.toml',
  'lattice.config.json',
];

export function discoverConfig(): string | null {
  for (const file of CONFIG_FILES) {
    const path = join(process.cwd(), file);
    if (existsSync(path)) return path;
  }
  return null;
}

export function loadConfig(path?: string): LatticeConfig {
  const configPath = path ?? discoverConfig();
  if (!configPath) return defaultConfig();

  const raw = parseConfigFile(configPath);
  return mergeConfigs(defaultConfig(), raw);
}
```

### 5. Error Boundaries

**Provider wrapper with timeout/rate-limit handling:**
```typescript
// packages/core/src/breaker/provider-wrapper.ts

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  provider: string,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new ProviderTimeoutError(provider, timeoutMs)), timeoutMs);
  });
  return Promise.race([fn(), timeout]);
}

async function withRateLimit<T>(
  fn: () => Promise<T>,
  provider: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new ProviderRateLimitError(provider, err.retryAfter);
    }
    throw err;
  }
}
```

## Package Structure

```
packages/
├── core/
│   ├── src/
│   │   ├── breaker/
│   │   │   ├── breaker.ts          # CircuitBreaker + persistence
│   │   │   ├── persistence/        # JSON/SQLite backends
│   │   │   └── tiered.ts           # TieredCircuitBreaker + embedding
│   │   ├── config/
│   │   │   ├── loader.ts           # Config file discovery + parsing
│   │   │   ├── schema.ts           # Config validation schema
│   │   │   └── types.ts            # LatticeConfig type
│   │   ├── observability/
│   │   │   ├── otel.ts             # OpenTelemetry exporter
│   │   │   └── json-line.ts        # JSON-line log exporter
│   │   ├── errors/
│   │   │   └── provider.ts         # ProviderTimeoutError, etc.
│   │   └── ...
├── provider-openai/
│   └── src/
│       ├── embedding.ts            # OpenAIEmbeddingProvider with batching
│       └── ...
└── adapter-parliament/
    └── src/
        └── index.ts                # ParliamentReducer + embedding integration
```

## Migration Path

All v0.3.0 code works unchanged. New features are opt-in:

```typescript
// v0.3.0 code — still works
const breaker = new CircuitBreaker({ failureThreshold: 3 });

// v0.4.0 — with persistence
const breaker = new CircuitBreaker({
  failureThreshold: 3,
  persist: { path: './circuit-state.json' },
});

// v0.3.0 code — still works
const wrapped = wrapAgent(fn, { id: 'agent', breaker: { tier: 'L1' } });

// v0.4.0 — with embedding
const wrapped = wrapAgent(fn, {
  id: 'agent',
  breaker: { tier: 'L1+L2' },
});
breaker.setEmbeddingProvider(createOpenAIEmbeddingProvider({ apiKey }));
```

## Testing Strategy

- **Unit tests** — each feature isolated with mocked providers
- **Integration tests** — full pipeline with real OpenAI embeddings
- **Persistence tests** — state survives process restart (simulated)
- **Error boundary tests** — timeout, rate-limit, malformed responses
- **Config tests** — auto-discovery, validation, override precedence

## Risks

| Risk | Mitigation |
|------|-----------|
| OTel SDK adds significant bundle size | Make OTel optional peer dep, JSON-line export always available |
| SQLite native bindings complicate install | JSON backend is default, SQLite is optional |
| Config file parsing adds dependencies | Use native `require()` for JS, minimal YAML/TOML parsers as optional deps |
| Embedding provider latency impacts validation | Batching + timeout + fallback to L1-only |

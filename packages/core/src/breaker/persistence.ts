/**
 * Persistence backends for CircuitBreaker state.
 *
 * Provides JSON file and in-memory backends for persisting
 * circuit breaker state across process restarts.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Persisted state for a single circuit breaker.
 */
export interface PersistedBreakerState {
  /** Breaker identifier */
  id: string;
  /** Current state */
  state: 'closed' | 'open' | 'half-open';
  /** Consecutive failure count */
  consecutiveFailures: number;
  /** When the circuit was opened (ISO 8601 or null) */
  openedAt: string | null;
  /** Recovery timeout in ms */
  recoveryTimeoutMs: number;
  /** Total times opened */
  timesOpened: number;
  /** Last state change timestamp */
  lastStateChange: string;
}

/**
 * Interface for circuit breaker state persistence.
 */
export interface PersistenceBackend {
  /** Get state for a breaker by ID */
  getState(id: string): Promise<PersistedBreakerState | null>;
  /** Save state for a breaker */
  setState(id: string, state: PersistedBreakerState): Promise<void>;
  /** Clear state for a breaker */
  clearState(id: string): Promise<void>;
}

/**
 * In-memory persistence backend (for testing / no persistence).
 */
export class MemoryBackend implements PersistenceBackend {
  private store = new Map<string, PersistedBreakerState>();

  async getState(id: string): Promise<PersistedBreakerState | null> {
    return this.store.get(id) ?? null;
  }

  async setState(id: string, state: PersistedBreakerState): Promise<void> {
    this.store.set(id, state);
  }

  async clearState(id: string): Promise<void> {
    this.store.delete(id);
  }
}

/**
 * JSON file persistence backend.
 *
 * Stores all breaker states in a single JSON file.
 * Uses atomic writes (temp file + rename) to prevent corruption.
 */
export class JsonFileBackend implements PersistenceBackend {
  private filePath: string;
  private cache: Map<string, PersistedBreakerState>;
  private syncIntervalMs: number;
  private syncTimer: NodeJS.Timeout | null;
  private dirty = false;

  constructor(filePath: string, syncIntervalMs: number = 1000) {
    this.filePath = filePath;
    this.syncIntervalMs = syncIntervalMs;
    this.cache = this.loadFromFile();
    this.syncTimer = null;
  }

  private loadFromFile(): Map<string, PersistedBreakerState> {
    if (!fs.existsSync(this.filePath)) {
      return new Map();
    }
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const entries: [string, PersistedBreakerState][] = JSON.parse(content);
      return new Map(entries);
    } catch {
      // Corrupt file — start fresh
      return new Map();
    }
  }

  private scheduleSync(): void {
    if (this.syncTimer) return;
    this.dirty = true;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (this.dirty) {
        this.writeToFile();
        this.dirty = false;
      }
    }, this.syncIntervalMs);
  }

  private writeToFile(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = this.filePath + '.tmp';
    const content = JSON.stringify([...this.cache.entries()], null, 2);
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  async getState(id: string): Promise<PersistedBreakerState | null> {
    return this.cache.get(id) ?? null;
  }

  async setState(id: string, state: PersistedBreakerState): Promise<void> {
    this.cache.set(id, state);
    this.scheduleSync();
  }

  async clearState(id: string): Promise<void> {
    this.cache.delete(id);
    this.scheduleSync();
  }

  /** Force immediate sync to disk */
  async flush(): Promise<void> {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.dirty) {
      this.writeToFile();
      this.dirty = false;
    }
  }

  /** Clean up resources */
  dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.dirty) {
      this.writeToFile();
    }
  }
}

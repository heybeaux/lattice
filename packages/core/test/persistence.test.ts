import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CircuitBreaker } from '../src/breaker/breaker.js';
import { JsonFileBackend, MemoryBackend } from '../src/breaker/persistence.js';

const TEST_DIR = path.join(__dirname, 'test-persistence');
const STATE_FILE = path.join(TEST_DIR, 'circuit-state.json');

describe('MemoryBackend', () => {
  it('stores and retrieves state', async () => {
    const backend = new MemoryBackend();
    const state = {
      id: 'test-breaker',
      state: 'open' as const,
      consecutiveFailures: 3,
      openedAt: new Date().toISOString(),
      recoveryTimeoutMs: 60000,
      timesOpened: 1,
      lastStateChange: new Date().toISOString(),
    };

    await backend.setState('test-breaker', state);
    const retrieved = await backend.getState('test-breaker');
    expect(retrieved).toEqual(state);
  });

  it('returns null for unknown ID', async () => {
    const backend = new MemoryBackend();
    const retrieved = await backend.getState('nonexistent');
    expect(retrieved).toBeNull();
  });

  it('clears state', async () => {
    const backend = new MemoryBackend();
    await backend.setState('test', {
      id: 'test',
      state: 'closed',
      consecutiveFailures: 0,
      openedAt: null,
      recoveryTimeoutMs: 60000,
      timesOpened: 0,
      lastStateChange: new Date().toISOString(),
    });
    await backend.clearState('test');
    expect(await backend.getState('test')).toBeNull();
  });
});

describe('JsonFileBackend', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  });

  afterEach(() => {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
    if (fs.existsSync(STATE_FILE + '.tmp')) {
      fs.unlinkSync(STATE_FILE + '.tmp');
    }
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('persists state to file', async () => {
    const backend = new JsonFileBackend(STATE_FILE, 10); // 10ms sync interval
    const state = {
      id: 'test-breaker',
      state: 'open' as const,
      consecutiveFailures: 3,
      openedAt: '2026-05-10T00:00:00.000Z',
      recoveryTimeoutMs: 60000,
      timesOpened: 1,
      lastStateChange: '2026-05-10T00:00:00.000Z',
    };

    await backend.setState('test-breaker', state);
    await backend.flush();

    // Read the file directly
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const entries = JSON.parse(content);
    expect(entries).toHaveLength(1);
    expect(entries[0][1].state).toBe('open');
  });

  it('loads state from file on construction', async () => {
    // Write a file first
    const state = {
      id: 'test-breaker',
      state: 'half-open' as const,
      consecutiveFailures: 2,
      openedAt: '2026-05-10T00:00:00.000Z',
      recoveryTimeoutMs: 60000,
      timesOpened: 1,
      lastStateChange: '2026-05-10T00:00:00.000Z',
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify([['test-breaker', state]]));

    const backend = new JsonFileBackend(STATE_FILE);
    const retrieved = await backend.getState('test-breaker');
    expect(retrieved?.state).toBe('half-open');
    expect(retrieved?.consecutiveFailures).toBe(2);
  });

  it('handles corrupt file gracefully', async () => {
    fs.writeFileSync(STATE_FILE, 'not valid json');
    const backend = new JsonFileBackend(STATE_FILE);
    expect(await backend.getState('anything')).toBeNull();
  });

  it('atomic write prevents corruption', async () => {
    const backend = new JsonFileBackend(STATE_FILE, 10);
    await backend.setState('a', {
      id: 'a', state: 'closed', consecutiveFailures: 0,
      openedAt: null, recoveryTimeoutMs: 60000, timesOpened: 0,
      lastStateChange: new Date().toISOString(),
    });
    await backend.flush();

    // File should exist and be valid
    expect(fs.existsSync(STATE_FILE)).toBe(true);
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('clears state', async () => {
    const backend = new JsonFileBackend(STATE_FILE, 10);
    await backend.setState('test', {
      id: 'test', state: 'closed', consecutiveFailures: 0,
      openedAt: null, recoveryTimeoutMs: 60000, timesOpened: 0,
      lastStateChange: new Date().toISOString(),
    });
    await backend.clearState('test');
    await backend.flush();

    expect(await backend.getState('test')).toBeNull();
  });
});

describe('CircuitBreaker with persistence', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  });

  afterEach(() => {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('persists state on failure', async () => {
    const backend = new JsonFileBackend(STATE_FILE, 10);
    const breaker = new CircuitBreaker({
      id: 'test-breaker',
      persistence: backend,
      failureThreshold: 2,
    });
    await breaker.restoreState();

    breaker.recordFailure(); // 1 failure
    breaker.recordFailure(); // 2 failures → open

    await backend.flush();

    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const entries = JSON.parse(content);
    expect(entries[0][1].state).toBe('open');
    expect(entries[0][1].consecutiveFailures).toBe(2);
    expect(entries[0][1].timesOpened).toBe(1);
  });

  it('restores state from file', async () => {
    // Write open state to file
    const openState = {
      id: 'test-breaker',
      state: 'open' as const,
      consecutiveFailures: 3,
      openedAt: new Date(Date.now() - 120000).toISOString(), // 2 min ago
      recoveryTimeoutMs: 60000, // 1 min timeout
      timesOpened: 1,
      lastStateChange: new Date(Date.now() - 120000).toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify([['test-breaker', openState]]));

    const backend = new JsonFileBackend(STATE_FILE);
    const breaker = new CircuitBreaker({
      id: 'test-breaker',
      persistence: backend,
      recoveryTimeoutMs: 60000,
    });
    await breaker.restoreState();

    // Recovery timeout (60s) has elapsed (opened 120s ago), so should be half-open
    expect(breaker.state).toBe('half-open');
    expect(breaker.metrics.timesOpened).toBe(1);
  });

  it('works without persistence (backward compatible)', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
  });
});

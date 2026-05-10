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

describe('JsonFileBackend — additional spec coverage', () => {
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

  // spec 1.2.5 — process-restart simulation
  it('1.2.5: new backend instance reads state written by a previous instance (process restart)', async () => {
    // Simulate "first process" — write state and flush.
    const backend1 = new JsonFileBackend(STATE_FILE, 10);
    const originalState = {
      id: 'restart-breaker',
      state: 'open' as const,
      consecutiveFailures: 5,
      openedAt: '2026-05-10T12:00:00.000Z',
      recoveryTimeoutMs: 60000,
      timesOpened: 2,
      lastStateChange: '2026-05-10T12:00:00.000Z',
    };
    await backend1.setState('restart-breaker', originalState);
    await backend1.flush();

    // Simulate "second process" — create a brand-new backend pointing to the same file.
    const backend2 = new JsonFileBackend(STATE_FILE);
    const restored = await backend2.getState('restart-breaker');

    expect(restored).not.toBeNull();
    expect(restored?.state).toBe('open');
    expect(restored?.consecutiveFailures).toBe(5);
    expect(restored?.timesOpened).toBe(2);
    expect(restored?.openedAt).toBe('2026-05-10T12:00:00.000Z');
  });

  // spec 1.4.2 — two breakers sharing one backend do not collide
  it('1.4.2: two CircuitBreaker instances sharing the same backend store separate entries', async () => {
    const backend = new JsonFileBackend(STATE_FILE, 10);

    // Write two distinct states directly via the backend to verify separate key storage.
    // (CircuitBreaker only persists on state transitions, so we use the backend API
    // directly here to assert the multi-key storage contract without depending on
    // internal breaker event sequencing.)
    const stateA = {
      id: 'breaker-a',
      state: 'open' as const,
      consecutiveFailures: 3,
      openedAt: new Date().toISOString(),
      recoveryTimeoutMs: 60000,
      timesOpened: 1,
      lastStateChange: new Date().toISOString(),
    };
    const stateB = {
      id: 'breaker-b',
      state: 'closed' as const,
      consecutiveFailures: 0,
      openedAt: null,
      recoveryTimeoutMs: 60000,
      timesOpened: 0,
      lastStateChange: new Date().toISOString(),
    };

    await backend.setState('breaker-a', stateA);
    await backend.setState('breaker-b', stateB);
    await backend.flush();

    // Each breaker must read back its OWN state without cross-contamination.
    const readA = await backend.getState('breaker-a');
    const readB = await backend.getState('breaker-b');

    expect(readA?.state).toBe('open');
    expect(readA?.consecutiveFailures).toBe(3);
    expect(readA?.timesOpened).toBe(1);

    expect(readB?.state).toBe('closed');
    expect(readB?.consecutiveFailures).toBe(0);

    // The file must hold exactly two separate entries.
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const entries: [string, { state: string }][] = JSON.parse(content);
    const entryMap = new Map(entries);

    expect(entryMap.get('breaker-a')?.state).toBe('open');
    expect(entryMap.get('breaker-b')?.state).toBe('closed');
    expect(entryMap.size).toBe(2);

    // Now create two fresh breakers pointing at the same file; they must not
    // overwrite each other's state.
    const breakerA = new CircuitBreaker({ id: 'breaker-a', persistence: backend, failureThreshold: 2 });
    const breakerB = new CircuitBreaker({ id: 'breaker-b', persistence: backend, failureThreshold: 2 });

    await breakerA.restoreState();
    await breakerB.restoreState();

    expect(breakerA.state).toBe('open');
    expect(breakerB.state).toBe('closed');
  });

  // spec 1.4.3 — concurrent writes from two breakers are both persisted
  it('1.4.3: concurrent setState calls from two breakers both survive after flush', async () => {
    const backend = new JsonFileBackend(STATE_FILE, 10);

    const makeState = (id: string, state: 'open' | 'closed'): Parameters<typeof backend.setState>[1] => ({
      id,
      state,
      consecutiveFailures: state === 'open' ? 3 : 0,
      openedAt: state === 'open' ? new Date().toISOString() : null,
      recoveryTimeoutMs: 60000,
      timesOpened: state === 'open' ? 1 : 0,
      lastStateChange: new Date().toISOString(),
    });

    // Fire both writes simultaneously — no await between them.
    await Promise.all([
      backend.setState('concurrent-a', makeState('concurrent-a', 'open')),
      backend.setState('concurrent-b', makeState('concurrent-b', 'closed')),
    ]);

    await backend.flush();

    const stateA = await backend.getState('concurrent-a');
    const stateB = await backend.getState('concurrent-b');

    expect(stateA).not.toBeNull();
    expect(stateA?.state).toBe('open');
    expect(stateA?.consecutiveFailures).toBe(3);

    expect(stateB).not.toBeNull();
    expect(stateB?.state).toBe('closed');
    expect(stateB?.consecutiveFailures).toBe(0);

    // Verify both are persisted on disk as well.
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const entries: [string, { state: string }][] = JSON.parse(content);
    expect(entries).toHaveLength(2);
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JsonLineExporter, EventEmitter } from '../src/index.js';

const TEST_DIR = path.join(__dirname, 'test-observability');
const LOG_FILE = path.join(TEST_DIR, 'test-events.jsonl');

describe('JsonLineExporter', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
  });

  afterEach(() => {
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('writes events to file', () => {
    const exporter = new JsonLineExporter({ outputPath: LOG_FILE });
    const emitter = new EventEmitter();
    exporter.attach(emitter);

    emitter.emit('contract:emitted', {
      fromAgent: 'test-agent',
      traceId: 'trace-1',
    });

    const entries = exporter.readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].event_type).toBe('contract:emitted');
    expect(entries[0].metadata.agent_id).toBe('test-agent');
    expect(entries[0].metadata.trace_id).toBe('trace-1');
    expect(entries[0].metadata.version).toBe('0.4.0');
  });

  it('writes multiple events', () => {
    const exporter = new JsonLineExporter({ outputPath: LOG_FILE });
    const emitter = new EventEmitter();
    exporter.attach(emitter);

    emitter.emit('contract:emitted', { fromAgent: 'a', traceId: 't1' });
    emitter.emit('contract:validated', { fromAgent: 'a', traceId: 't1' });
    emitter.emit('contract:rejected', { fromAgent: 'b', traceId: 't1' });
    emitter.emit('pipeline:completed', { traceId: 't1', contractCount: 2 });

    const entries = exporter.readEntries();
    expect(entries).toHaveLength(4);
    expect(entries[0].event_type).toBe('contract:emitted');
    expect(entries[1].event_type).toBe('contract:validated');
    expect(entries[2].event_type).toBe('contract:rejected');
    expect(entries[3].event_type).toBe('pipeline:completed');
  });

  it('each line is valid JSON', () => {
    const exporter = new JsonLineExporter({ outputPath: LOG_FILE });
    const emitter = new EventEmitter();
    exporter.attach(emitter);

    emitter.emit('contract:emitted', { fromAgent: 'a', traceId: 't1' });
    emitter.emit('pipeline:completed', { traceId: 't1', contractCount: 2 });

    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('custom version', () => {
    const exporter = new JsonLineExporter({ outputPath: LOG_FILE, version: 'custom-1.0' });
    const emitter = new EventEmitter();
    exporter.attach(emitter);

    emitter.emit('contract:emitted', { fromAgent: 'test' });

    const entries = exporter.readEntries();
    expect(entries[0].metadata.version).toBe('custom-1.0');
  });

  it('readEntries returns empty for non-existent file', () => {
    const exporter = new JsonLineExporter({ outputPath: '/nonexistent/path/file.jsonl' });
    expect(exporter.readEntries()).toEqual([]);
  });

  it('clear removes all entries', () => {
    const exporter = new JsonLineExporter({ outputPath: LOG_FILE });
    const emitter = new EventEmitter();
    exporter.attach(emitter);

    emitter.emit('contract:emitted', { fromAgent: 'test' });
    expect(exporter.readEntries()).toHaveLength(1);

    exporter.clear();
    expect(exporter.readEntries()).toHaveLength(0);
  });

  it('creates directory if not exists', () => {
    const deepPath = path.join(TEST_DIR, 'deep', 'nested', 'dir', 'events.jsonl');
    const exporter = new JsonLineExporter({ outputPath: deepPath });
    const emitter = new EventEmitter();
    exporter.attach(emitter);

    emitter.emit('contract:emitted', { fromAgent: 'test' });

    expect(fs.existsSync(deepPath)).toBe(true);
    expect(exporter.readEntries()).toHaveLength(1);
  });

  it('attaches to all event types', () => {
    const exporter = new JsonLineExporter({ outputPath: LOG_FILE });
    const emitter = new EventEmitter();
    exporter.attach(emitter);

    const eventTypes = [
      'contract:emitted',
      'contract:validated',
      'contract:rejected',
      'circuit:opened',
      'circuit:closed',
      'circuit:half-open',
      'pipeline:started',
      'pipeline:completed',
      'pipeline:aborted',
    ];

    for (const eventType of eventTypes) {
      emitter.emit(eventType as any, { fromAgent: 'test', traceId: 't1' });
    }

    const entries = exporter.readEntries();
    expect(entries).toHaveLength(9);
    expect(entries.map(e => e.event_type)).toEqual(eventTypes);
  });
});

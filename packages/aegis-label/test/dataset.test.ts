/**
 * Dataset writer — idempotency on decisionEventId (no double-write), the
 * (signalDate, severity) walk-forward index, and the honesty stamps
 * (dataSource + schemaVersion) on every artifact.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DatasetStore,
  appendRows,
  readExistingIds,
  serializeRows,
} from '../src/dataset.js';
import { SCHEMA_VERSION } from '../src/types.js';
import type { FrozenRow } from '../src/types.js';
import { decisionEvent } from './fixtures.js';
import { assembleFeatures } from '../src/features.js';
import { stubPriors } from './fixtures.js';

function frozen(
  id: string,
  over: Partial<FrozenRow> = {},
): FrozenRow {
  const features = assembleFeatures({
    decisionEvent: decisionEvent({ id }),
    priorEvents: [],
    priors: stubPriors,
  });
  return {
    features,
    action_failed: 0,
    labelReason: null,
    labelConfidence: null,
    decisionEventId: id,
    signalDate: features.signalDate,
    dataSource: 'real',
    schemaVersion: SCHEMA_VERSION,
    ...over,
  };
}

const tmpDirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-label-'));
  tmpDirs.push(dir);
  return join(dir, 'dataset.jsonl');
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('appendRows — idempotency', () => {
  it('skips a decisionEventId already on disk (no double-write)', () => {
    const path = tmpFile();
    const r1 = appendRows(path, [frozen('a'), frozen('b')]);
    expect(r1).toEqual({ written: 2, skipped: 0 });

    const r2 = appendRows(path, [frozen('a'), frozen('c')]);
    expect(r2).toEqual({ written: 1, skipped: 1 });

    expect(readExistingIds(path)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('dedups duplicates within a single batch', () => {
    const path = tmpFile();
    const r = appendRows(path, [frozen('a'), frozen('a')]);
    expect(r).toEqual({ written: 1, skipped: 1 });
  });

  it('stamps schemaVersion on every written row', () => {
    const path = tmpFile();
    appendRows(path, [frozen('a')]);
    const line = readFileSync(path, 'utf8').trim();
    const parsed = JSON.parse(line) as FrozenRow;
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.dataSource).toBe('real');
  });
});

describe('DatasetStore — index + idempotency', () => {
  it('is idempotent across appends, hydrating dedup from disk', () => {
    const path = tmpFile();
    const s1 = new DatasetStore(path);
    expect(s1.append([frozen('a'), frozen('b')])).toEqual({
      written: 2,
      skipped: 0,
    });

    // A fresh store over the same file must see the existing ids.
    const s2 = new DatasetStore(path);
    expect(s2.has('a')).toBe(true);
    expect(s2.append([frozen('a'), frozen('c')])).toEqual({
      written: 1,
      skipped: 1,
    });
  });

  it('indexes rows on (signalDate, severity) for walk-forward folds', () => {
    const store = new DatasetStore(); // in-memory only
    store.append([
      frozen('hi-1'), // severity 'high', date 2026-06-14
      frozen('hi-2'),
      frozen('crit-1', {
        features: {
          ...frozen('crit-1').features,
          ruleSeverityMax: 'critical',
        },
      }),
    ]);
    expect(store.query('2026-06-14', 'high').map((r) => r.decisionEventId)).toEqual(
      ['hi-1', 'hi-2'],
    );
    expect(store.query('2026-06-14', 'critical')).toHaveLength(1);
    expect(store.query('2026-06-14', 'low')).toHaveLength(0);
    expect(store.size).toBe(3);
  });
});

describe('DatasetStore — SQLite index', () => {
  it('persists the (signalDate, severity) fold index to SQLite and hydrates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-label-'));
    tmpDirs.push(dir);
    const jsonl = join(dir, 'dataset.jsonl');
    const sqlite = join(dir, 'index.sqlite');

    const s1 = new DatasetStore({ path: jsonl, sqliteIndexPath: sqlite });
    s1.append([
      frozen('hi-1'),
      frozen('crit-1', {
        features: { ...frozen('crit-1').features, ruleSeverityMax: 'critical' },
      }),
    ]);
    // SQLite fold read returns the persisted row directly.
    expect(s1.queryDb('2026-06-14', 'high').map((r) => r.decisionEventId)).toEqual(
      ['hi-1'],
    );
    expect(s1.queryDb('2026-06-14', 'critical')).toHaveLength(1);
    s1.close();

    // A fresh store over the same SQLite index hydrates dedup + folds from it.
    const s2 = new DatasetStore({ path: jsonl, sqliteIndexPath: sqlite });
    expect(s2.has('hi-1')).toBe(true);
    expect(s2.has('crit-1')).toBe(true);
    expect(s2.query('2026-06-14', 'high').map((r) => r.decisionEventId)).toEqual([
      'hi-1',
    ]);
    // Re-appending an existing id is a no-op (idempotent across SQLite too).
    expect(s2.append([frozen('hi-1')])).toEqual({ written: 0, skipped: 1 });
    s2.close();
  });

  it('works with an in-memory SQLite index (:memory:)', () => {
    const store = new DatasetStore({ sqliteIndexPath: ':memory:' });
    store.append([frozen('a')]);
    expect(store.queryDb('2026-06-14', 'high')).toHaveLength(1);
    store.close();
  });
});

describe('serializeRows', () => {
  it('emits one JSON object per line, schema-stamped', () => {
    const out = serializeRows([frozen('a'), frozen('b')]);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!) as FrozenRow;
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

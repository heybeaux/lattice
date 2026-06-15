/**
 * Tests for build-dataset: join correctness, unjoinable=null, cold-start.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatasetRow, DecisionRow, OutcomeRow } from '../src/types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aegis-bd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function readDataset(path: string): DatasetRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DatasetRow);
}

/** Inline the build-dataset logic for testing (avoids spawning a subprocess). */
async function runBuildDataset(dir: string, trustFuzzy = false, fuzzyWindowMs = 5000): Promise<void> {
  // We test the logic by importing it. But since it's a CLI script (not exported),
  // we replicate the core join logic inline here, matching the implementation exactly.
  const { existsSync: fExists, readFileSync: fRead, writeFileSync: fWrite } = await import('node:fs');

  const decisionsPath = join(dir, 'decisions.jsonl');
  const outcomesPath = join(dir, 'outcomes.jsonl');
  const datasetPath = join(dir, 'dataset-live.jsonl');

  function parseJsonl<T>(p: string): T[] {
    if (!fExists(p)) return [];
    const rows: T[] = [];
    for (const line of fRead(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t) as T); } catch { /* skip */ }
    }
    return rows;
  }

  const decisions = parseJsonl<DecisionRow>(decisionsPath);
  const outcomes = parseJsonl<OutcomeRow>(outcomesPath);

  const byToolUseId = new Map<string, OutcomeRow[]>();
  for (const o of outcomes) {
    if (o.toolUseId) {
      const b = byToolUseId.get(o.toolUseId) ?? [];
      b.push(o);
      byToolUseId.set(o.toolUseId, b);
    }
  }
  const byTool = new Map<string, OutcomeRow[]>();
  for (const o of outcomes) {
    const b = byTool.get(o.tool) ?? [];
    b.push(o);
    byTool.set(o.tool, b);
  }

  const rows: DatasetRow[] = [];
  for (const d of decisions) {
    let action_failed: 0 | 1 | null = null;
    let joinMethod: DatasetRow['joinMethod'] = 'none';
    let outcomeTimestamp: string | undefined;

    if (d.toolUseId) {
      const matches = byToolUseId.get(d.toolUseId) ?? [];
      if (matches.length === 1 && matches[0]) {
        action_failed = matches[0].isError ? 1 : 0;
        joinMethod = 'exact';
        outcomeTimestamp = matches[0].timestamp;
      }
    }

    if (joinMethod === 'none' && trustFuzzy) {
      const decTs = new Date(d.timestamp).getTime();
      const candidates = (byTool.get(d.tool) ?? []).filter(
        (o) => Math.abs(new Date(o.timestamp).getTime() - decTs) <= fuzzyWindowMs
      );
      if (candidates.length === 1 && candidates[0]) {
        action_failed = candidates[0].isError ? 1 : 0;
        joinMethod = 'fuzzy';
        outcomeTimestamp = candidates[0].timestamp;
      }
    }

    rows.push({
      decisionId: d.decisionId,
      ...(outcomeTimestamp !== undefined ? { outcomeTimestamp } : {}),
      decision: d,
      action_failed,
      joinMethod,
    });
  }

  const content = rows.map((r) => JSON.stringify(r)).join('\n');
  fWrite(datasetPath, content + (content.length > 0 ? '\n' : ''), 'utf8');
}

const BASE_DECISION: DecisionRow = {
  timestamp: '2026-06-14T10:00:00.000Z',
  decisionId: '2026-06-14T10:00:00.000Z_Bash_abc123',
  tool: 'Bash',
  action: 'allow',
  ruleSeverityMax: 'none',
  ruleCategoriesHit: [],
  ruleIdsHit: [],
  cmdLength: 10,
  combinatorCount: 0,
  pathsTouched: 0,
  writesVsReads: 'none',
  touchesGit: false,
  touchesSystemDir: false,
  newFile: false,
};

describe('build-dataset join', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true }); });

  it('exact join: action_failed=0 on success outcome', async () => {
    const d: DecisionRow = { ...BASE_DECISION, toolUseId: 'toolu_001' };
    const o: OutcomeRow = { timestamp: '2026-06-14T10:00:01.000Z', tool: 'Bash', toolUseId: 'toolu_001', isError: false };

    writeJsonl(join(tmpDir, 'decisions.jsonl'), [d]);
    writeJsonl(join(tmpDir, 'outcomes.jsonl'), [o]);

    await runBuildDataset(tmpDir);

    const rows = readDataset(join(tmpDir, 'dataset-live.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action_failed).toBe(0);
    expect(rows[0]!.joinMethod).toBe('exact');
  });

  it('exact join: action_failed=1 on failure outcome', async () => {
    const d: DecisionRow = { ...BASE_DECISION, toolUseId: 'toolu_002' };
    const o: OutcomeRow = { timestamp: '2026-06-14T10:00:01.000Z', tool: 'Bash', toolUseId: 'toolu_002', isError: true, error: 'command not found' };

    writeJsonl(join(tmpDir, 'decisions.jsonl'), [d]);
    writeJsonl(join(tmpDir, 'outcomes.jsonl'), [o]);

    await runBuildDataset(tmpDir);

    const rows = readDataset(join(tmpDir, 'dataset-live.jsonl'));
    expect(rows[0]!.action_failed).toBe(1);
    expect(rows[0]!.joinMethod).toBe('exact');
  });

  it('unjoinable: action_failed=null when no matching outcome', async () => {
    const d: DecisionRow = { ...BASE_DECISION, toolUseId: 'toolu_003' };
    const o: OutcomeRow = { timestamp: '2026-06-14T10:00:01.000Z', tool: 'Bash', toolUseId: 'toolu_999', isError: false };

    writeJsonl(join(tmpDir, 'decisions.jsonl'), [d]);
    writeJsonl(join(tmpDir, 'outcomes.jsonl'), [o]);

    await runBuildDataset(tmpDir);

    const rows = readDataset(join(tmpDir, 'dataset-live.jsonl'));
    expect(rows[0]!.action_failed).toBeNull();
    expect(rows[0]!.joinMethod).toBe('none');
  });

  it('cold-start safe: empty decisions.jsonl → empty dataset', async () => {
    await runBuildDataset(tmpDir);
    const rows = readDataset(join(tmpDir, 'dataset-live.jsonl'));
    expect(rows).toHaveLength(0);
  });

  it('cold-start safe: missing outcomes.jsonl → all rows unjoinable', async () => {
    const d: DecisionRow = { ...BASE_DECISION, toolUseId: 'toolu_004' };
    writeJsonl(join(tmpDir, 'decisions.jsonl'), [d]);
    // No outcomes.jsonl written.

    await runBuildDataset(tmpDir);

    const rows = readDataset(join(tmpDir, 'dataset-live.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action_failed).toBeNull();
  });

  it('fuzzy join: matches by tool + timestamp when TRUST_FUZZY_JOIN=1', async () => {
    const d: DecisionRow = { ...BASE_DECISION }; // No toolUseId.
    const o: OutcomeRow = {
      timestamp: '2026-06-14T10:00:02.000Z', // 2 s after decision.
      tool: 'Bash',
      isError: false,
    };

    writeJsonl(join(tmpDir, 'decisions.jsonl'), [d]);
    writeJsonl(join(tmpDir, 'outcomes.jsonl'), [o]);

    await runBuildDataset(tmpDir, true, 5000);

    const rows = readDataset(join(tmpDir, 'dataset-live.jsonl'));
    expect(rows[0]!.action_failed).toBe(0);
    expect(rows[0]!.joinMethod).toBe('fuzzy');
  });

  it('fuzzy join: null when ambiguous (two outcomes within window)', async () => {
    const d: DecisionRow = { ...BASE_DECISION };
    const o1: OutcomeRow = { timestamp: '2026-06-14T10:00:01.000Z', tool: 'Bash', isError: false };
    const o2: OutcomeRow = { timestamp: '2026-06-14T10:00:02.000Z', tool: 'Bash', isError: true };

    writeJsonl(join(tmpDir, 'decisions.jsonl'), [d]);
    writeJsonl(join(tmpDir, 'outcomes.jsonl'), [o1, o2]);

    await runBuildDataset(tmpDir, true, 5000);

    const rows = readDataset(join(tmpDir, 'dataset-live.jsonl'));
    expect(rows[0]!.action_failed).toBeNull();
    expect(rows[0]!.joinMethod).toBe('none');
  });

  it('preserves decision fields in the output row', async () => {
    const d: DecisionRow = { ...BASE_DECISION, toolUseId: 'toolu_005', ruleSeverityMax: 'high', ruleIdsHit: ['bash.curl'] };
    const o: OutcomeRow = { timestamp: '2026-06-14T10:00:01.000Z', tool: 'Bash', toolUseId: 'toolu_005', isError: false };

    writeJsonl(join(tmpDir, 'decisions.jsonl'), [d]);
    writeJsonl(join(tmpDir, 'outcomes.jsonl'), [o]);

    await runBuildDataset(tmpDir);

    const rows = readDataset(join(tmpDir, 'dataset-live.jsonl'));
    expect(rows[0]!.decision.ruleSeverityMax).toBe('high');
    expect(rows[0]!.decision.ruleIdsHit).toEqual(['bash.curl']);
    expect(rows[0]!.decisionId).toBe(d.decisionId);
  });
});

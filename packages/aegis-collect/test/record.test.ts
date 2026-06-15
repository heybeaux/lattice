/**
 * Tests for recordDecision: correct JSONL output, fail-open, cold-start.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Evaluation, ToolCall } from '@heybeaux/lattice-aegis';
import { recordDecision } from '../src/record.js';
import type { DecisionRow } from '../src/types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aegis-collect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ALLOW_EVAL: Evaluation = {
  action: 'allow',
  decidedBy: 'severity',
  matches: [],
  reason: 'No rules fired',
  ruleVersions: ['bash@0.1.0'],
};

const DENY_EVAL: Evaluation = {
  action: 'deny',
  decidedBy: 'severity',
  matches: [{ id: 'bash.rm-rf', severity: 'critical', category: 'bash', target: 'command' }],
  reason: 'Matched bash.rm-rf',
  ruleVersions: ['bash@0.1.0'],
  prediction: { pFailure: 0.92, confidence: 0.8, source: 'awm' },
};

const BASH_CALL: ToolCall = {
  tool: 'Bash',
  command: 'ls -la /tmp',
};

const RM_CALL: ToolCall = {
  tool: 'Bash',
  command: 'rm -rf / --no-preserve-root',
};

describe('recordDecision', () => {
  let tmpDir: string;
  const origEnv = process.env['AEGIS_COLLECT_DIR'];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env['AEGIS_COLLECT_DIR'] = tmpDir;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['AEGIS_COLLECT_DIR'];
    } else {
      process.env['AEGIS_COLLECT_DIR'] = origEnv;
    }
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('writes a valid JSONL line for an allow decision', () => {
    recordDecision(BASH_CALL, ALLOW_EVAL);

    const file = join(tmpDir, 'decisions.jsonl');
    expect(existsSync(file)).toBe(true);

    const line = readFileSync(file, 'utf8').trim();
    const row: DecisionRow = JSON.parse(line);

    expect(row.tool).toBe('Bash');
    expect(row.action).toBe('allow');
    expect(row.ruleSeverityMax).toBe('none');
    expect(row.ruleCategoriesHit).toEqual([]);
    expect(row.ruleIdsHit).toEqual([]);
    expect(row.cmdLength).toBe('ls -la /tmp'.length);
    expect(row.pFailure).toBeUndefined();
    expect(row.decisionId).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof row.timestamp).toBe('string');
  });

  it('writes correct fields for a deny decision with a critical rule hit', () => {
    recordDecision(RM_CALL, DENY_EVAL);

    const file = join(tmpDir, 'decisions.jsonl');
    const line = readFileSync(file, 'utf8').trim();
    const row: DecisionRow = JSON.parse(line);

    expect(row.action).toBe('deny');
    expect(row.ruleSeverityMax).toBe('critical');
    expect(row.ruleIdsHit).toEqual(['bash.rm-rf']);
    expect(row.ruleCategoriesHit).toEqual(['bash']);
    expect(row.pFailure).toBe(0.92);
  });

  it('stamps toolUseId when provided', () => {
    recordDecision(BASH_CALL, ALLOW_EVAL, 'toolu_abc123');

    const file = join(tmpDir, 'decisions.jsonl');
    const row: DecisionRow = JSON.parse(readFileSync(file, 'utf8').trim());
    expect(row.toolUseId).toBe('toolu_abc123');
  });

  it('does NOT stamp toolUseId when not provided', () => {
    recordDecision(BASH_CALL, ALLOW_EVAL);

    const file = join(tmpDir, 'decisions.jsonl');
    const row: DecisionRow = JSON.parse(readFileSync(file, 'utf8').trim());
    expect('toolUseId' in row).toBe(false);
  });

  it('appends multiple rows (one per call)', () => {
    recordDecision(BASH_CALL, ALLOW_EVAL);
    recordDecision(RM_CALL, DENY_EVAL);

    const file = join(tmpDir, 'decisions.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first: DecisionRow = JSON.parse(lines[0]!);
    const second: DecisionRow = JSON.parse(lines[1]!);
    expect(first.action).toBe('allow');
    expect(second.action).toBe('deny');
  });

  it('is fail-open when the directory is not writable', () => {
    // Point to a path that can't be created (file in place of dir).
    process.env['AEGIS_COLLECT_DIR'] = '/dev/null/impossible_path';

    // Must not throw.
    expect(() => recordDecision(BASH_CALL, ALLOW_EVAL)).not.toThrow();
  });

  it('cold-start safe: works when decisions.jsonl does not yet exist', () => {
    // No file created yet — should write the first line cleanly.
    recordDecision(BASH_CALL, ALLOW_EVAL);
    const file = join(tmpDir, 'decisions.jsonl');
    expect(existsSync(file)).toBe(true);
  });

  it('classifies Write tool as newFile=true', () => {
    const writeCall: ToolCall = { tool: 'Write', paths: ['/tmp/foo.txt'], content: 'hello' };
    recordDecision(writeCall, ALLOW_EVAL);
    const row: DecisionRow = JSON.parse(readFileSync(join(tmpDir, 'decisions.jsonl'), 'utf8').trim());
    expect(row.newFile).toBe(true);
    expect(row.writesVsReads).toBe('write');
  });
});

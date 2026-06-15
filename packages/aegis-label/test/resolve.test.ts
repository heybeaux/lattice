/**
 * Label resolver — the §2 priority table, first-match-wins, plus the
 * abnormal-end → null rule and rollback path-overlap. Highest-risk logic.
 */

import { describe, it, expect } from 'vitest';
import { resolveLabel, resourcesOverlap, normalizePath } from '../src/resolve.js';
import {
  FixtureReader,
  decisionEvent,
  outcomeEvent,
  kindEvent,
  tsPlus,
} from './fixtures.js';

const DECISION_ID = 'sonder:decision-1';
const DECISION_RESOURCES = ['/repo/src/a.ts'];

describe('resolveLabel — single signals', () => {
  it('tool_error fires on isError outcome (confidence 1.0)', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: true }),
    ]);
    const r = resolveLabel(DECISION_ID, reader, DECISION_RESOURCES);
    expect(r).toEqual({
      action_failed: 1,
      labelReason: 'tool_error',
      labelConfidence: 1.0,
    });
  });

  it('tool_error fires on non-zero exit code', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: false, exit_code: 127 }),
    ]);
    expect(resolveLabel(DECISION_ID, reader, DECISION_RESOURCES).labelReason).toBe(
      'tool_error',
    );
  });

  it('exit_code 0 is success, not tool_error', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: false, exit_code: 0 }),
    ]);
    const r = resolveLabel(DECISION_ID, reader, DECISION_RESOURCES);
    expect(r.action_failed).toBe(0);
    expect(r.labelReason).toBeNull();
  });

  it('human_veto fires on a veto descendant (confidence 1.0)', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      kindEvent('v1', DECISION_ID, { kind: 'veto' }),
    ]);
    const r = resolveLabel(DECISION_ID, reader, DECISION_RESOURCES);
    expect(r).toEqual({
      action_failed: 1,
      labelReason: 'human_veto',
      labelConfidence: 1.0,
    });
  });

  it('downstream_error fires on severity=error descendant (confidence 0.7)', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      kindEvent('d1', DECISION_ID, { severity: 'error' }),
    ]);
    const r = resolveLabel(DECISION_ID, reader, DECISION_RESOURCES);
    expect(r).toEqual({
      action_failed: 1,
      labelReason: 'downstream_error',
      labelConfidence: 0.7,
    });
  });

  it('rollback fires on overlapping resources (confidence 0.7)', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      kindEvent(
        'rb1',
        DECISION_ID,
        { kind: 'rollback' },
        { resources: ['/repo/src/a.ts'] },
      ),
    ]);
    const r = resolveLabel(DECISION_ID, reader, DECISION_RESOURCES);
    expect(r).toEqual({
      action_failed: 1,
      labelReason: 'rollback',
      labelConfidence: 0.7,
    });
  });

  it('rollback does NOT fire when resources do not overlap', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      kindEvent(
        'rb1',
        DECISION_ID,
        { kind: 'rollback' },
        { resources: ['/other/place.ts'] },
      ),
    ]);
    expect(resolveLabel(DECISION_ID, reader, DECISION_RESOURCES).action_failed).toBe(
      0,
    );
  });

  it('rollback fires from a git command string on overlapping path', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      kindEvent(
        'rb1',
        DECISION_ID,
        { command: 'git restore /repo/src/a.ts' },
        { paths: ['/repo/src/a.ts'] },
      ),
    ]);
    expect(resolveLabel(DECISION_ID, reader, DECISION_RESOURCES).labelReason).toBe(
      'rollback',
    );
  });

  it('no signal → success (0, null reason)', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: false, exit_code: 0 }),
    ]);
    expect(resolveLabel(DECISION_ID, reader, DECISION_RESOURCES)).toEqual({
      action_failed: 0,
      labelReason: null,
      labelConfidence: null,
    });
  });
});

describe('resolveLabel — priority order (first-match-wins)', () => {
  it('human_veto beats a coincidental tool_error', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: true }),
      kindEvent('v1', DECISION_ID, { kind: 'veto' }),
    ]);
    expect(resolveLabel(DECISION_ID, reader, DECISION_RESOURCES).labelReason).toBe(
      'human_veto',
    );
  });

  it('tool_error beats downstream_error and rollback', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: true }),
      kindEvent('d1', DECISION_ID, { severity: 'error' }),
      kindEvent('rb1', DECISION_ID, { kind: 'rollback' }, { resources: ['/repo/src/a.ts'] }),
    ]);
    expect(resolveLabel(DECISION_ID, reader, DECISION_RESOURCES).labelReason).toBe(
      'tool_error',
    );
  });

  it('downstream_error beats rollback', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      kindEvent('d1', DECISION_ID, { severity: 'error' }),
      kindEvent('rb1', DECISION_ID, { kind: 'rollback' }, { resources: ['/repo/src/a.ts'] }),
    ]);
    expect(resolveLabel(DECISION_ID, reader, DECISION_RESOURCES).labelReason).toBe(
      'downstream_error',
    );
  });
});

describe('resolveLabel — abnormal end & traversal', () => {
  it('abnormal session end → null (never guess)', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: true }),
    ]);
    const r = resolveLabel(DECISION_ID, reader, DECISION_RESOURCES, {
      abnormalSessionEnd: true,
    });
    expect(r).toEqual({ action_failed: null, labelReason: null, labelConfidence: null });
  });

  it('catches a multi-hop downstream descendant', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: false, exit_code: 0 }),
      kindEvent('d1', 'o1', { severity: 'error' }),
    ]);
    expect(resolveLabel(DECISION_ID, reader, DECISION_RESOURCES).labelReason).toBe(
      'downstream_error',
    );
  });

  it('respects windowCloseTs time bound', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: true }, { timestamp: tsPlus(9999) }),
    ]);
    // The error is outside the window → not counted.
    const r = resolveLabel(DECISION_ID, reader, DECISION_RESOURCES, {
      windowCloseTs: tsPlus(600),
    });
    expect(r.action_failed).toBe(0);
  });
});

describe('resourcesOverlap & normalizePath', () => {
  it('exact and prefix overlap match at segment boundary', () => {
    expect(resourcesOverlap(['/a/b'], ['/a/b'])).toBe(true);
    expect(resourcesOverlap(['/a'], ['/a/b/c'])).toBe(true);
    expect(resourcesOverlap(['/a/b/c'], ['/a'])).toBe(true);
  });

  it('partial-segment is NOT an overlap', () => {
    expect(resourcesOverlap(['/a/bc'], ['/a/b'])).toBe(false);
  });

  it('normalizePath collapses slashes and trims trailing slash', () => {
    expect(normalizePath('/a//b/')).toBe('/a/b');
    expect(normalizePath('/')).toBe('/');
  });
});

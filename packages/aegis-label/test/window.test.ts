/**
 * Window manager — wall-clock cap, per-category override, end-of-session,
 * early-close on tool_error/human_veto, and the next-user-turn seam.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WINDOW_CONFIG,
  computeWindowDeadline,
  evaluateWindowClose,
} from '../src/window.js';
import { mintRow } from '../src/mint.js';
import {
  BASE_TS,
  FixtureReader,
  decisionEvent,
  outcomeEvent,
  kindEvent,
  stubPriors,
  tsPlus,
} from './fixtures.js';

function pendingRow(category = 'file_write') {
  const row = mintRow({
    decisionEvent: decisionEvent({}, { windowCategory: category }),
    priorEvents: [],
    priors: stubPriors,
  });
  if (row === null) throw new Error('expected a minted row');
  return row;
}

describe('computeWindowDeadline', () => {
  it('uses the 10-min default for ordinary categories', () => {
    const d = computeWindowDeadline(BASE_TS, 'file_write');
    expect(d).toBe(tsPlus(600));
  });

  it('uses the 30-min override for bash/secrets', () => {
    expect(computeWindowDeadline(BASE_TS, 'bash')).toBe(tsPlus(1800));
    expect(computeWindowDeadline(BASE_TS, 'secrets')).toBe(tsPlus(1800));
  });

  it('falls back to default for unknown categories and undefined', () => {
    expect(computeWindowDeadline(BASE_TS, 'pii')).toBe(tsPlus(600));
    expect(computeWindowDeadline(BASE_TS, undefined)).toBe(tsPlus(600));
  });
});

describe('evaluateWindowClose', () => {
  it('stays open before the wall-clock deadline with no signals', () => {
    const row = pendingRow();
    const d = evaluateWindowClose({
      row,
      descendants: [],
      now: tsPlus(60),
    });
    expect(d.closed).toBe(false);
  });

  it('closes on wall-clock at/after the deadline', () => {
    const row = pendingRow();
    const d = evaluateWindowClose({
      row,
      descendants: [],
      now: tsPlus(601),
    });
    expect(d).toMatchObject({ closed: true, reason: 'wall_clock' });
  });

  it('early-closes on a tool_error before the deadline', () => {
    const row = pendingRow();
    const d = evaluateWindowClose({
      row,
      descendants: [outcomeEvent('o1', row.decisionEventId, { isError: true })],
      now: tsPlus(30),
    });
    expect(d).toMatchObject({ closed: true, reason: 'early_close' });
  });

  it('early-closes on a human veto before the deadline', () => {
    const row = pendingRow();
    const d = evaluateWindowClose({
      row,
      descendants: [kindEvent('v1', row.decisionEventId, { kind: 'veto' })],
      now: tsPlus(30),
    });
    expect(d).toMatchObject({ closed: true, reason: 'early_close' });
  });

  it('closes on end-of-session inside the window, flagging abnormal end', () => {
    const row = pendingRow();
    const d = evaluateWindowClose({
      row,
      descendants: [],
      now: tsPlus(120),
      sessionEnd: { ts: tsPlus(90), abnormal: true },
    });
    expect(d).toMatchObject({
      closed: true,
      reason: 'end_of_session',
      abnormalEnd: true,
    });
  });

  it('honors the next-user-turn seam when provided', () => {
    const row = pendingRow();
    const d = evaluateWindowClose({
      row,
      descendants: [],
      now: tsPlus(200),
      nextUserTurnTs: tsPlus(150),
    });
    expect(d).toMatchObject({ closed: true, reason: 'next_user_turn' });
    expect(d.closedAt).toBe(tsPlus(150));
  });
});

// Used to keep the reader import meaningful and assert DAG shape parity.
describe('fixture reader parity', () => {
  it('queryDescendants excludes the root and is BFS', () => {
    const reader = new FixtureReader([
      decisionEvent(),
      outcomeEvent('o1', 'sonder:decision-1', { isError: false, exit_code: 0 }),
      kindEvent('d1', 'o1', { severity: 'error' }),
    ]);
    const ids = reader.queryDescendants('sonder:decision-1').map((e) => e.id);
    expect(ids).toEqual(['o1', 'd1']);
  });
});

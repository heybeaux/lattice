/**
 * Live-chain orchestrator — runLabeling drives mint → window → resolve →
 * features → dataset end-to-end over a SonderChainReader. Covers:
 *  - tool_error outcome  → action_failed = 1
 *  - clean allow (exit 0) → action_failed = 0
 *  - deny channel skipped (not minted)
 *  - open window not appended
 *  - honesty stamp: every real-chain row is dataSource: 'real'
 *  - the FeatureLeakError guard is NOT bypassed by the driver
 */

import { describe, it, expect } from 'vitest';
import { runLabeling } from '../src/run.js';
import { SonderChainReader } from '../src/sonder-reader.js';
import type { AuditLogLike, AuditLogQueryFilter } from '../src/sonder-reader.js';
import { DatasetStore } from '../src/dataset.js';
import { assembleFeatures, FeatureLeakError } from '../src/features.js';
import {
  decisionEvent,
  outcomeEvent,
  stubPriors,
  BASE_TS,
  tsPlus,
} from './fixtures.js';

/** Minimal in-memory AuditLog fake (timestamp-ordered query, BFS descendants). */
class FakeAuditLog implements AuditLogLike {
  private readonly events: Record<string, unknown>[];
  constructor(events: unknown[]) {
    this.events = events.map((e) => e as Record<string, unknown>);
  }
  query(filter: AuditLogQueryFilter): unknown[] {
    return this.events
      .filter((e) => {
        if (filter.agent_id && e['agent_id'] !== filter.agent_id) return false;
        if (filter.task_id && e['task_id'] !== filter.task_id) return false;
        if (filter.parent_id && e['parent_id'] !== filter.parent_id) {
          return false;
        }
        if (filter.from && (e['timestamp'] as string) < filter.from) {
          return false;
        }
        if (filter.to && (e['timestamp'] as string) > filter.to) return false;
        return true;
      })
      .sort((a, b) =>
        (a['timestamp'] as string).localeCompare(b['timestamp'] as string),
      );
  }
  queryChildren(parent_id: string): unknown[] {
    return this.query({ parent_id });
  }
  queryDescendants(rootId: string, opts: { maxDepth?: number } = {}): unknown[] {
    const maxDepth = opts.maxDepth ?? Infinity;
    const out: unknown[] = [];
    const visited = new Set<string>([rootId]);
    let frontier: string[] = [rootId];
    let depth = 0;
    while (frontier.length > 0 && depth < maxDepth) {
      const next: string[] = [];
      for (const pid of frontier) {
        for (const child of this.query({ parent_id: pid })) {
          const id = (child as Record<string, unknown>)['id'] as string;
          if (visited.has(id)) continue;
          visited.add(id);
          out.push(child);
          next.push(id);
        }
      }
      frontier = next;
      depth += 1;
    }
    return out;
  }
}

const DECISION_ID = 'sonder:decision-1';
// A "now" well past any 10/30-min window so wall-clock close fires.
const NOW = tsPlus(60 * 60);

describe('runLabeling — outcome labels', () => {
  it('labels a tool_error outcome as action_failed = 1', () => {
    const reader = new SonderChainReader(
      new FakeAuditLog([
        decisionEvent(),
        outcomeEvent('o1', DECISION_ID, { isError: true }),
      ]),
    );
    const { frozen, append } = runLabeling({ reader, priors: stubPriors, now: NOW });
    expect(frozen).toHaveLength(1);
    expect(frozen[0]?.action_failed).toBe(1);
    expect(frozen[0]?.labelReason).toBe('tool_error');
    expect(append.written).toBe(1);
  });

  it('labels a clean allow (exit 0) as action_failed = 0', () => {
    const reader = new SonderChainReader(
      new FakeAuditLog([
        decisionEvent(),
        outcomeEvent('o1', DECISION_ID, { isError: false, exit_code: 0 }),
      ]),
    );
    const { frozen } = runLabeling({ reader, priors: stubPriors, now: NOW });
    expect(frozen).toHaveLength(1);
    expect(frozen[0]?.action_failed).toBe(0);
    expect(frozen[0]?.labelReason).toBeNull();
  });
});

describe('runLabeling — minting + window gating', () => {
  it('skips denied decisions (deny channel)', () => {
    const denied = decisionEvent({
      id: 'sonder:denied-1',
      governance: {
        approval_gate: { state: 'denied', gate_id: 'g1', default_action: 'deny' },
      },
    });
    const reader = new SonderChainReader(new FakeAuditLog([denied]));
    const { frozen, skippedDeny } = runLabeling({
      reader,
      priors: stubPriors,
      now: NOW,
    });
    expect(frozen).toHaveLength(0);
    expect(skippedDeny).toBe(1);
  });

  it('does not append a row whose window is still open', () => {
    const reader = new SonderChainReader(
      new FakeAuditLog([
        decisionEvent(),
        outcomeEvent('o1', DECISION_ID, { isError: false, exit_code: 0 }),
      ]),
    );
    // "now" == decision time → no early close, wall-clock not reached → open.
    const { frozen, stillOpen, append } = runLabeling({
      reader,
      priors: stubPriors,
      now: BASE_TS,
    });
    expect(frozen).toHaveLength(0);
    expect(stillOpen).toHaveLength(1);
    expect(append.written).toBe(0);
  });

  it('only mints from decision events, not outcome/veto descendants', () => {
    const reader = new SonderChainReader(
      new FakeAuditLog([
        decisionEvent(),
        outcomeEvent('o1', DECISION_ID, { isError: true }),
      ]),
    );
    const { frozen } = runLabeling({ reader, priors: stubPriors, now: NOW });
    // One decision → exactly one frozen row (the outcome event is a descendant).
    expect(frozen.map((r) => r.decisionEventId)).toEqual([DECISION_ID]);
  });
});

describe('runLabeling — honesty stamp (scope §7)', () => {
  it('stamps every real-chain row dataSource: "real" and schemaVersion', () => {
    const reader = new SonderChainReader(
      new FakeAuditLog([
        decisionEvent(),
        outcomeEvent('o1', DECISION_ID, { isError: true }),
      ]),
    );
    const { frozen } = runLabeling({ reader, priors: stubPriors, now: NOW });
    expect(frozen[0]?.dataSource).toBe('real');
    expect(frozen[0]?.schemaVersion).toBe(1);
  });

  it('produces frozen rows the DatasetStore can dedup on re-run', () => {
    const store = new DatasetStore();
    const events = [
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: true }),
    ];
    const reader = new SonderChainReader(new FakeAuditLog(events));
    runLabeling({ reader, store, priors: stubPriors, now: NOW });
    // Second run over the same chain must not double-write.
    const second = runLabeling({ reader, store, priors: stubPriors, now: NOW });
    expect(second.append.written).toBe(0);
    expect(second.append.skipped).toBe(1);
    expect(store.size).toBe(1);
  });
});

describe('runLabeling — leak guard intact', () => {
  it('the underlying FeatureLeakError guard is still wired (not removed)', () => {
    // The driver routes priorEvents straight into assembleFeatures and never
    // relaxes its guard. Directly assert the guard still throws on a feature
    // sourced after the decision — the orchestrator composes this function
    // unchanged, so the walk-forward guarantee holds through the live path.
    const decision = decisionEvent({ timestamp: BASE_TS });
    const future = outcomeEvent(
      'future',
      DECISION_ID,
      { isError: false, exit_code: 0 },
      { timestamp: tsPlus(120) },
    );
    expect(() =>
      assembleFeatures({
        decisionEvent: decision,
        priorEvents: [decision, future], // `future` is after the decision → leak
        priors: stubPriors,
      }),
    ).toThrow(FeatureLeakError);
  });

  it('the driver never feeds future events into the feature assembler', () => {
    // A chain whose query returns events out of order: an event timestamped
    // AFTER the decision appears earlier in the list. The driver's
    // `timestamp <= decision.timestamp` filter must exclude it, so no leak is
    // ever assembled and the run completes without throwing.
    const decision = decisionEvent({ timestamp: BASE_TS });
    const later = outcomeEvent('later', DECISION_ID, { isError: false }, {
      timestamp: tsPlus(120),
    });
    const outOfOrderLog: AuditLogLike = {
      query: (_f: AuditLogQueryFilter) => [later, decision], // later listed first
      queryChildren: () => [],
      queryDescendants: () => [],
    };
    const reader = new SonderChainReader(outOfOrderLog);
    expect(() =>
      runLabeling({ reader, priors: stubPriors, now: NOW }),
    ).not.toThrow();
  });
});

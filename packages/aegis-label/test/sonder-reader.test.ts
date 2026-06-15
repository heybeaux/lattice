/**
 * Live-chain adapter — SonderChainReader maps a real-shaped AuditLog into the
 * ChainReader port + SonderEventLike envelope. Verifies the normalizer, the
 * queryChildren/queryDescendants pass-through, and BOTH getEvent paths: the
 * O(1) rawDb primary-key lookup and the O(n) query() fallback (no id filter
 * exists in EventFilter — see sonder-reader.ts header).
 */

import { describe, it, expect } from 'vitest';
import {
  SonderChainReader,
  normalizeEvent,
} from '../src/sonder-reader.js';
import type {
  AuditLogLike,
  AuditLogQueryFilter,
} from '../src/sonder-reader.js';
import { decisionEvent, outcomeEvent, BASE_TS } from './fixtures.js';

/**
 * An in-memory fake of the real Sonder AuditLog surface. Mirrors its
 * query/queryChildren/queryDescendants semantics (timestamp ASC, root excluded,
 * BFS). `withRawDb` toggles the O(1) lookup path on/off so we can exercise both
 * getEvent branches.
 */
class FakeAuditLog implements AuditLogLike {
  private readonly events: Record<string, unknown>[];

  constructor(events: unknown[], withRawDb = false) {
    this.events = events.map((e) => e as Record<string, unknown>);
    // Only expose the rawDb escape hatch when asked, so the O(n) fallback path
    // (rawDb absent) is genuinely exercised — the reader detects rawDb by
    // presence, not by it throwing.
    if (!withRawDb) {
      (this as { rawDb?: unknown }).rawDb = undefined;
    }
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

  rawDb() {
    const events = this.events;
    return {
      prepare(_sql: string) {
        return {
          get(id: unknown): unknown {
            const hit = events.find((e) => e['id'] === id);
            return hit === undefined
              ? undefined
              : { payload: JSON.stringify(hit) };
          },
        };
      },
    };
  }
}

const DECISION_ID = 'sonder:decision-1';

describe('normalizeEvent', () => {
  it('projects a SonderEventAny-shaped object into SonderEventLike', () => {
    const raw = decisionEvent();
    const norm = normalizeEvent(raw);
    expect(norm.id).toBe(DECISION_ID);
    expect(norm.agent_id).toBe('rook');
    expect(norm.task_id).toBe('task-1');
    expect(norm.governance.approval_gate?.state).toBe('allowed');
    expect(norm.metadata?.['aegis']).toBeDefined();
  });

  it('omits absent optionals (exactOptionalPropertyTypes-safe)', () => {
    const norm = normalizeEvent({
      id: 'x',
      agent_id: 'a',
      task_id: 't',
      timestamp: BASE_TS,
      governance: {},
      payload: {},
    });
    expect('parent_id' in norm).toBe(false);
    expect('outcome' in norm).toBe(false);
    expect('resources' in norm).toBe(false);
  });

  it('preserves outcome and resources when present', () => {
    const norm = normalizeEvent(
      outcomeEvent('o1', DECISION_ID, { isError: true }, {
        resources: ['/repo/x.ts'],
      }),
    );
    expect(norm.outcome?.isError).toBe(true);
    expect(norm.resources).toEqual(['/repo/x.ts']);
    expect(norm.parent_id).toBe(DECISION_ID);
  });
});

describe('SonderChainReader — port methods', () => {
  it('queryChildren returns normalized direct children', () => {
    const log = new FakeAuditLog([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: false, exit_code: 0 }),
    ]);
    const reader = new SonderChainReader(log);
    const kids = reader.queryChildren(DECISION_ID);
    expect(kids).toHaveLength(1);
    expect(kids[0]?.id).toBe('o1');
  });

  it('queryDescendants walks multi-hop and excludes the root', () => {
    const log = new FakeAuditLog([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: false, exit_code: 0 }),
      outcomeEvent('o2', 'o1', { isError: true }),
    ]);
    const reader = new SonderChainReader(log);
    const desc = reader.queryDescendants(DECISION_ID);
    expect(desc.map((e) => e.id)).toEqual(['o1', 'o2']);
  });

  it('queryDescendants honors maxDepth', () => {
    const log = new FakeAuditLog([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: false }),
      outcomeEvent('o2', 'o1', { isError: true }),
    ]);
    const reader = new SonderChainReader(log);
    expect(
      reader.queryDescendants(DECISION_ID, { maxDepth: 1 }).map((e) => e.id),
    ).toEqual(['o1']);
  });
});

describe('SonderChainReader — getEvent', () => {
  it('uses the O(1) rawDb primary-key lookup when available', () => {
    const log = new FakeAuditLog([decisionEvent()], /* withRawDb */ true);
    const reader = new SonderChainReader(log);
    const got = reader.getEvent(DECISION_ID);
    expect(got?.id).toBe(DECISION_ID);
    expect(got?.metadata?.['aegis']).toBeDefined();
  });

  it('falls back to the O(n) query scan when rawDb is absent', () => {
    const log = new FakeAuditLog([
      decisionEvent(),
      outcomeEvent('o1', DECISION_ID, { isError: true }),
    ]); // withRawDb defaults to false
    const reader = new SonderChainReader(log);
    expect(reader.getEvent('o1')?.outcome?.isError).toBe(true);
  });

  it('returns null for an unknown id (both paths)', () => {
    const withRaw = new SonderChainReader(
      new FakeAuditLog([decisionEvent()], true),
    );
    const noRaw = new SonderChainReader(new FakeAuditLog([decisionEvent()]));
    expect(withRaw.getEvent('nope')).toBeNull();
    expect(noRaw.getEvent('nope')).toBeNull();
  });
});

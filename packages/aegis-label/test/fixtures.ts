/**
 * Synthetic SonderEventLike chains + a fixture AuditLogReader / EngramPriorPort,
 * for fixture-based testing of the labeling pipeline. All deterministic.
 */

import type {
  AegisDecisionMeta,
  ChainReader,
  PriorSource,
  SonderEventLike,
} from '../src/types.js';

export const BASE_TS = '2026-06-14T12:00:00.000Z';

/** Offset an ISO timestamp by N seconds. */
export function tsPlus(seconds: number, base = BASE_TS): string {
  return new Date(Date.parse(base) + seconds * 1000).toISOString();
}

export function decisionMeta(
  over: Partial<AegisDecisionMeta> = {},
): AegisDecisionMeta {
  return {
    tool: 'Bash',
    ruleSeverityMax: 'high',
    ruleCategoriesHit: ['bash'],
    ruleIdsHit: ['bash.git-force-push'],
    cmdLength: 42,
    combinatorCount: 1,
    pathsTouched: 1,
    writesVsReads: 'write',
    touchesGit: false,
    touchesSystemDir: false,
    newFile: false,
    windowCategory: 'bash',
    ...over,
  };
}

/** Build a decision (pre-execution) event that was allowed to run. */
export function decisionEvent(
  over: Partial<SonderEventLike> = {},
  meta: Partial<AegisDecisionMeta> = {},
): SonderEventLike {
  return {
    id: 'sonder:decision-1',
    agent_id: 'rook',
    task_id: 'task-1',
    timestamp: BASE_TS,
    governance: { approval_gate: { state: 'allowed', gate_id: 'g1', default_action: 'deny' } },
    paths: ['/repo/src/a.ts'],
    resources: ['/repo/src/a.ts'],
    payload: {},
    metadata: { aegis: decisionMeta(meta) },
    ...over,
  };
}

/** Build a post-execution outcome event chained to a parent. */
export function outcomeEvent(
  id: string,
  parent_id: string,
  outcome: { isError: boolean; exit_code?: number; error?: string },
  over: Partial<SonderEventLike> = {},
): SonderEventLike {
  return {
    id,
    agent_id: 'rook',
    task_id: 'task-1',
    parent_id,
    timestamp: tsPlus(30),
    governance: {},
    outcome,
    payload: {},
    ...over,
  };
}

/** Build an event with a metadata `kind` tag (veto / undo / rollback / etc.). */
export function kindEvent(
  id: string,
  parent_id: string,
  metadata: Record<string, unknown>,
  over: Partial<SonderEventLike> = {},
): SonderEventLike {
  return {
    id,
    agent_id: 'rook',
    task_id: 'task-1',
    parent_id,
    timestamp: tsPlus(60),
    governance: {},
    payload: {},
    metadata,
    ...over,
  };
}

/**
 * An in-memory AuditLogReader over a flat list of events, using parent_id to
 * build the DAG. Mirrors the real queryChildren/queryDescendants semantics
 * (root excluded, BFS, cycle-safe).
 */
export class FixtureReader implements ChainReader {
  private readonly byParent = new Map<string, SonderEventLike[]>();
  private readonly byId = new Map<string, SonderEventLike>();

  constructor(events: SonderEventLike[]) {
    for (const e of events) {
      this.byId.set(e.id, e);
      if (e.parent_id === undefined) continue;
      const list = this.byParent.get(e.parent_id) ?? [];
      list.push(e);
      this.byParent.set(e.parent_id, list);
    }
  }

  getEvent(id: string): SonderEventLike | null {
    return this.byId.get(id) ?? null;
  }

  queryChildren(parent_id: string): SonderEventLike[] {
    return this.byParent.get(parent_id) ?? [];
  }

  queryDescendants(
    rootId: string,
    opts: { maxDepth?: number } = {},
  ): SonderEventLike[] {
    const maxDepth = opts.maxDepth ?? Infinity;
    const out: SonderEventLike[] = [];
    const visited = new Set<string>([rootId]);
    let frontier: string[] = [rootId];
    let depth = 0;
    while (frontier.length > 0 && depth < maxDepth) {
      const next: string[] = [];
      for (const pid of frontier) {
        for (const child of this.queryChildren(pid)) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          out.push(child);
          next.push(child.id);
        }
      }
      frontier = next;
      depth += 1;
    }
    return out;
  }
}

/** A deterministic non-zero prior stub (distinct from the zero-prior default). */
export const stubPriors: PriorSource = {
  lookup: () => ({
    histFailRate_toolPath: 0.04,
    secsSinceLastFailHere: 86400,
    engramPriorN: 37,
  }),
};

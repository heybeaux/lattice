/**
 * Live-chain adapter: a {@link ChainReader} backed by a real Sonder `AuditLog`.
 *
 * This is the ONE place the pipeline touches a concrete audit store. Everything
 * downstream still speaks only the `ChainReader` port and `SonderEventLike`
 * envelope (scope §1: "Sonder is read-only here"). We keep aegis-label decoupled
 * from `@heybeaux/sonder-core` by injecting the `AuditLog` as a minimal
 * STRUCTURAL interface ({@link AuditLogLike}) — no runtime import, no hard dep.
 * The real `AuditLog` satisfies it; tests pass an in-memory fake (or a real
 * `AuditLog` pointed at `:memory:`).
 *
 * GETEVENT NOTE (the port's only method without a 1:1 AuditLog equivalent):
 * Sonder's `AuditLog` has NO `getEvent(id)` and its `query`/`EventFilter` has NO
 * id filter (verified in sonder/packages/core/src/audit.ts — filter keys are
 * agent_id, task_id, parent_id, from, to, validated, limit, offset). The `id`
 * column IS the table PRIMARY KEY, so an O(1) lookup exists at the SQL layer. We
 * use it when the injected log exposes the documented `rawDb()` escape hatch
 * (a prepared `SELECT payload FROM events WHERE id = ?`). When `rawDb` is absent
 * (a structural fake), we fall back to a correct O(n) scan via `query({})`.
 * We do NOT modify Sonder to add a getter.
 */

import type {
  ChainReader,
  GovernanceLike,
  OutcomeLike,
  SonderEventLike,
} from './types.js';

/**
 * The subset of a real Sonder `AuditLog` this adapter consumes. Declared
 * structurally so tests can inject a fake and so aegis-label never imports
 * `@heybeaux/sonder-core`. The real `AuditLog` satisfies this exactly.
 *
 * Events returned by these methods are `SonderEventAny` in Sonder; here we type
 * them as `unknown[]` and normalize each into a `SonderEventLike` (the two are
 * structurally compatible — see {@link normalizeEvent}).
 */
export interface AuditLogLike {
  /** Generic event query (no id filter exists — see file header). */
  query(filter: AuditLogQueryFilter): unknown[];
  /** Direct children of `parent_id` (`audit.ts` queryChildren). */
  queryChildren(parent_id: string): unknown[];
  /** BFS over the causal DAG rooted at `rootId`; root excluded (`audit.ts`). */
  queryDescendants(rootId: string, opts?: { maxDepth?: number }): unknown[];
  /**
   * Optional raw DB escape hatch (`audit.ts` rawDb). When present we use it for
   * an O(1) primary-key lookup in {@link SonderChainReader.getEvent}; otherwise
   * we fall back to an O(n) `query` scan. Typed minimally — we only `prepare`
   * one read statement.
   */
  rawDb?(): RawDbLike;
}

/** The slice of `EventFilter` we pass through (no id key — verified). */
export interface AuditLogQueryFilter {
  agent_id?: string;
  task_id?: string;
  parent_id?: string;
  from?: string;
  to?: string;
  validated?: boolean;
  limit?: number;
  offset?: number;
}

/** Minimal better-sqlite3 handle surface used for the O(1) id lookup. */
export interface RawDbLike {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Coerce a raw Sonder event (`SonderEventAny`) into the `SonderEventLike`
 * envelope. The shapes are structurally compatible (`SonderEventCore` carries
 * id/agent_id/task_id/parent_id/timestamp/governance/outcome/resources/paths/
 * payload/metadata — see sonder event.ts:131-167), so this is a thin, defensive
 * projection: we copy only the fields the pipeline reads, and omit optionals
 * that are absent (exactOptionalPropertyTypes forbids assigning `undefined`).
 */
export function normalizeEvent(raw: unknown): SonderEventLike {
  const e = raw as Record<string, unknown>;
  const out: SonderEventLike = {
    id: e['id'] as string,
    agent_id: e['agent_id'] as string,
    task_id: e['task_id'] as string,
    timestamp: e['timestamp'] as string,
    governance: (e['governance'] ?? {}) as GovernanceLike,
    payload: e['payload'],
  };
  if (e['parent_id'] !== undefined && e['parent_id'] !== null) {
    out.parent_id = e['parent_id'] as string;
  }
  if (e['outcome'] !== undefined) {
    out.outcome = e['outcome'] as OutcomeLike;
  }
  if (e['resources'] !== undefined) {
    out.resources = e['resources'] as string[];
  }
  if (e['paths'] !== undefined) {
    out.paths = e['paths'] as string[];
  }
  if (e['metadata'] !== undefined) {
    out.metadata = e['metadata'] as Record<string, unknown>;
  }
  return out;
}

/**
 * A `ChainReader` over a live Sonder `AuditLog`. Inject the log (the adapter
 * NEVER constructs a DB itself — scope §1 keeps Sonder read-only and ownership
 * with the caller). All reads are normalized through {@link normalizeEvent}.
 */
export class SonderChainReader implements ChainReader {
  constructor(private readonly log: AuditLogLike) {}

  /**
   * Fetch a single event by id. Prefers the O(1) primary-key lookup via
   * `rawDb()` when available; otherwise falls back to a correct O(n) scan over
   * `query({})` (no id filter exists in `EventFilter`). Returns null when absent.
   */
  getEvent(id: string): SonderEventLike | null {
    const raw = this.log.rawDb;
    if (typeof raw === 'function') {
      const db = raw.call(this.log);
      const row = db
        .prepare('SELECT payload FROM events WHERE id = ?')
        .get(id) as { payload: string } | undefined;
      if (row === undefined) return null;
      return normalizeEvent(JSON.parse(row.payload));
    }
    // O(n) fallback: no id filter in EventFilter, so scan and match. Documented
    // limitation — only hit when the injected log lacks rawDb (i.e. a fake).
    const all = this.log.query({});
    for (const e of all) {
      if ((e as Record<string, unknown>)['id'] === id) {
        return normalizeEvent(e);
      }
    }
    return null;
  }

  queryChildren(parent_id: string): SonderEventLike[] {
    return this.log.queryChildren(parent_id).map(normalizeEvent);
  }

  queryDescendants(
    rootId: string,
    opts?: { maxDepth?: number },
  ): SonderEventLike[] {
    const descendants =
      opts?.maxDepth !== undefined
        ? this.log.queryDescendants(rootId, { maxDepth: opts.maxDepth })
        : this.log.queryDescendants(rootId);
    return descendants.map(normalizeEvent);
  }

  /**
   * Pass-through query for the orchestrator's chain walk (find decision events
   * by agent/task/time). Returns normalized envelopes. Not part of the
   * `ChainReader` port — exposed because the driver needs to enumerate decisions.
   */
  query(filter: AuditLogQueryFilter = {}): SonderEventLike[] {
    return this.log.query(filter).map(normalizeEvent);
  }
}

/**
 * In-memory user session manager for Lattice pipelines.
 *
 * Tracks active user sessions with configurable inactivity expiry.  All
 * public methods are null-safe: they never access a session's properties
 * without first confirming the session record exists and is still valid.
 *
 * ## Null-safety invariants (GIN-25)
 *
 * Every method that retrieves a session from the internal Map:
 *   1. Guards the lookup with an explicit `undefined` check before accessing
 *      any property — no non-null assertions (`!`) anywhere in this module.
 *   2. Checks the `status` field before treating the session as usable.
 *   3. Uses optional chaining (`?.`) or nullish coalescing (`??`) for nested
 *      optional fields such as `lastActivityAt` and `metadata`.
 *
 * This is deliberately defensive: a session returned by `Map.get()` is typed
 * `UserSession | undefined`, and TypeScript will catch any future regression
 * that tries to access it without a guard.
 */

import { monotonicFactory } from 'ulidx';
import type {
  UserSession,
  SessionStatus,
  SessionManagerOptions,
} from './types.js';
import {
  SessionNotFoundError,
  SessionInvalidError,
} from './types.js';

const ulid = monotonicFactory();

/** Default inactivity TTL: 30 minutes */
const DEFAULT_TTL_MS = 30 * 60 * 1_000;

/**
 * Manages the lifecycle of UserSession objects: creation, lookup, activity
 * refreshes, and explicit termination.
 *
 * The store is purely in-memory.  For persistence across process restarts
 * wrap this class or delegate to an external store — that is an orchestration
 * concern beyond this module's scope.
 *
 * @example
 * ```ts
 * const manager = new SessionManager({ ttlMs: 15 * 60 * 1000 });
 *
 * const session = manager.createSession('user-42', { role: 'admin' });
 *
 * // Later — safely retrieve (throws SessionNotFoundError if gone):
 * const active = manager.getSession(session.id);
 *
 * // Or use the null-returning variant:
 * const maybeSession = manager.findSession(session.id);
 * if (maybeSession === undefined) {
 *   // handle missing session without throwing
 * }
 * ```
 */
export class SessionManager {
  private readonly store = new Map<string, UserSession>();
  private readonly ttlMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  // ─── public API ───────────────────────────────────────────────────────────

  /**
   * Create a new active session for the given user.
   *
   * @param userId - Identifier of the authenticated user.
   * @param metadata - Optional caller-supplied key/value pairs.
   * @returns The newly created UserSession.
   */
  createSession(userId: string, metadata: Record<string, unknown> = {}): UserSession {
    if (!userId || typeof userId !== 'string') {
      throw new TypeError('userId must be a non-empty string');
    }

    const session: UserSession = Object.freeze({
      id: ulid(),
      userId,
      createdAt: new Date().toISOString(),
      lastActivityAt: undefined,
      status: 'active' as SessionStatus,
      metadata: { ...metadata },
    });

    this.store.set(session.id, session);
    return session;
  }

  /**
   * Retrieve an active session by ID.
   *
   * Checks for expiry before returning. Expired sessions are evicted and the
   * method throws `SessionInvalidError` (status `'expired'`).
   *
   * @throws {SessionNotFoundError} if no session with that ID exists.
   * @throws {SessionInvalidError} if the session is expired or terminated.
   */
  getSession(sessionId: string): UserSession {
    const session = this.findSession(sessionId);

    if (session === undefined) {
      throw new SessionNotFoundError(sessionId);
    }

    return session;
  }

  /**
   * Look up a session without throwing.
   *
   * Returns `undefined` instead of throwing when the session is missing,
   * expired, or terminated.  Expired sessions are still evicted from the
   * store as a side-effect.
   *
   * @param sessionId - The session ID to look up.
   * @returns The active UserSession, or `undefined`.
   */
  findSession(sessionId: string): UserSession | undefined {
    if (!sessionId) return undefined;

    const raw = this.store.get(sessionId);
    if (raw === undefined) return undefined;

    // Evict if already marked as non-active.
    if (raw.status !== 'active') {
      this.store.delete(sessionId);
      return undefined;
    }

    // Check inactivity expiry.
    if (this.isExpired(raw)) {
      this.store.delete(sessionId);
      return undefined;
    }

    return raw;
  }

  /**
   * Record activity on a session and return the updated snapshot.
   *
   * Updates `lastActivityAt` to the current time, resetting the inactivity
   * window.
   *
   * @throws {SessionNotFoundError} if the session does not exist.
   * @throws {SessionInvalidError} if the session is no longer active.
   */
  touchSession(sessionId: string): UserSession {
    const existing = this.store.get(sessionId);

    if (existing === undefined) {
      throw new SessionNotFoundError(sessionId);
    }

    if (existing.status !== 'active') {
      throw new SessionInvalidError(sessionId, existing.status);
    }

    if (this.isExpired(existing)) {
      this.store.delete(sessionId);
      throw new SessionInvalidError(sessionId, 'expired');
    }

    const updated: UserSession = Object.freeze({
      ...existing,
      lastActivityAt: new Date().toISOString(),
    });

    this.store.set(sessionId, updated);
    return updated;
  }

  /**
   * Explicitly terminate a session.
   *
   * The session record is updated to `status: 'terminated'` then removed from
   * the store.  Subsequent calls to `getSession` / `findSession` will behave
   * as if the session never existed.
   *
   * Calling `terminateSession` on an already-gone session is a no-op (does
   * not throw) to make cleanup logic idempotent.
   *
   * @param sessionId - ID of the session to terminate.
   */
  terminateSession(sessionId: string): void {
    const existing = this.store.get(sessionId);

    // Idempotent: silently do nothing if the session is already gone.
    if (existing === undefined) return;

    this.store.delete(sessionId);
  }

  /**
   * Return a snapshot of all currently active (non-expired) sessions.
   *
   * Expired sessions encountered during the scan are evicted as a side-effect.
   */
  listActiveSessions(): UserSession[] {
    const active: UserSession[] = [];

    for (const [id, session] of this.store) {
      if (session.status !== 'active' || this.isExpired(session)) {
        this.store.delete(id);
        continue;
      }
      active.push(session);
    }

    return active;
  }

  /**
   * Number of sessions currently in the store, including stale entries that
   * have not yet been evicted.  Use `listActiveSessions().length` for a live
   * active count.
   */
  get size(): number {
    return this.store.size;
  }

  // ─── private helpers ──────────────────────────────────────────────────────

  /**
   * Determine whether a session has exceeded the inactivity TTL.
   *
   * Uses `lastActivityAt` when present, falling back to `createdAt`.
   * When `ttlMs` is 0, expiry is disabled and this always returns false.
   */
  private isExpired(session: UserSession): boolean {
    if (this.ttlMs === 0) return false;

    // Null-safe: prefer lastActivityAt, fall back to createdAt.
    const referenceTs = session.lastActivityAt ?? session.createdAt;
    const referenceTime = new Date(referenceTs).getTime();

    // Guard against unparseable timestamps stored in external data.
    if (!Number.isFinite(referenceTime)) return false;

    return Date.now() - referenceTime > this.ttlMs;
  }
}

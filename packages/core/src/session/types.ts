/**
 * Type definitions for the Lattice user session management module.
 *
 * A UserSession tracks authentication state, activity timestamps, and
 * per-session metadata for a single authenticated user in a multi-agent
 * pipeline run.
 */

/** Session status values */
export type SessionStatus = 'active' | 'expired' | 'terminated';

/**
 * Immutable snapshot of a user session.
 *
 * All fields set at creation time are required. The optional fields
 * (`lastActivityAt`, `metadata`) default to sensible values but may be
 * undefined in sessions restored from external stores that did not record
 * them.
 */
export interface UserSession {
  /** Unique session identifier (ULID recommended) */
  readonly id: string;
  /** Identifier of the authenticated user */
  readonly userId: string;
  /** ISO 8601 timestamp when the session was created */
  readonly createdAt: string;
  /** ISO 8601 timestamp of the most recent activity; undefined for brand-new sessions */
  readonly lastActivityAt: string | undefined;
  /** Current lifecycle status of the session */
  readonly status: SessionStatus;
  /** Caller-supplied arbitrary metadata */
  readonly metadata: Record<string, unknown>;
}

/**
 * Options for constructing the SessionManager.
 */
export interface SessionManagerOptions {
  /**
   * Inactivity timeout in milliseconds.  A session that has seen no activity
   * for longer than this window is considered expired and will be evicted
   * from the in-memory store on the next call that touches it.
   *
   * Defaults to 30 minutes (1 800 000 ms).  Pass `0` to disable automatic
   * expiry (sessions live until explicitly terminated).
   */
  ttlMs?: number;
}

/**
 * Thrown when a requested session does not exist in the manager's store.
 *
 * Callers should catch this and surface an appropriate 401/403 or pipeline
 * abort rather than allowing the error to propagate silently.
 */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Thrown when an operation is attempted on an expired or terminated session.
 */
export class SessionInvalidError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly status: SessionStatus,
  ) {
    super(`Session "${sessionId}" is not active (status: ${status})`);
    this.name = 'SessionInvalidError';
  }
}

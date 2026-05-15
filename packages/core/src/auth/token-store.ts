/**
 * One-time-use and refresh token management for Lattice authentication flows.
 *
 * This module closes the token reuse vulnerability (GIN-24) by ensuring:
 *
 *   1. **One-time tokens** (magic link, password reset, email verification)
 *      are immediately invalidated on first consumption — a second call with
 *      the same token value receives `TokenAlreadyUsedError`, making replay
 *      attacks impossible.
 *
 *   2. **Refresh tokens** follow a strict rotation protocol — consuming a
 *      refresh token atomically invalidates the old token and issues a new
 *      one. Replaying the old value yields `TokenAlreadyUsedError`. Using an
 *      already-expired value yields `TokenExpiredError`.
 *
 *   3. **Logout** immediately revokes the designated token record, so a
 *      stolen token that is replayed after logout is rejected.
 *
 * ## Security invariants
 *
 *   - `consumeToken` is the single gate for one-time-use flows. It atomically
 *     marks `usedAt` before returning — there is no window between "check" and
 *     "use" because the whole store is synchronous in-memory.
 *   - `rotateRefreshToken` atomically replaces old → new; the old record's
 *     `usedAt` is set before the new record is written.
 *   - `revokeToken` marks the record as revoked regardless of its current
 *     status, making logout idempotent.
 *   - Expired tokens are rejected at the gate with `TokenExpiredError`, even
 *     if they have never been used.
 *
 * @module auth/token-store
 */

import { monotonicFactory } from 'ulidx';

const ulid = monotonicFactory();

// ─── Token types ──────────────────────────────────────────────────────────────

/**
 * The category of auth token, which drives validation policy.
 *
 *   - `'one_time'`   — consumed exactly once then permanently invalidated.
 *   - `'refresh'`    — consumed and replaced with a new token on each use.
 */
export type TokenKind = 'one_time' | 'refresh';

/**
 * Lifecycle status of a stored token.
 *
 *   - `'pending'`  — issued, never consumed.
 *   - `'used'`     — consumed (one_time) or rotated (refresh).
 *   - `'revoked'`  — explicitly revoked (e.g. logout).
 *   - `'expired'`  — TTL exceeded before consumption.
 */
export type TokenStatus = 'pending' | 'used' | 'revoked' | 'expired';

/**
 * Immutable snapshot of a stored auth token.
 */
export interface AuthToken {
  /** Opaque token value — the string the client must present. */
  readonly value: string;
  /** The kind of token: one-time or refresh. */
  readonly kind: TokenKind;
  /** Identifier of the user this token belongs to. */
  readonly userId: string;
  /** ISO 8601 timestamp when the token was issued. */
  readonly issuedAt: string;
  /** ISO 8601 timestamp when the token expires; undefined means no expiry. */
  readonly expiresAt: string | undefined;
  /** ISO 8601 timestamp of first (and only) consumption; undefined until used. */
  readonly usedAt: string | undefined;
  /** ISO 8601 timestamp of explicit revocation; undefined until revoked. */
  readonly revokedAt: string | undefined;
  /** Current lifecycle status. */
  readonly status: TokenStatus;
  /** Caller-supplied purpose label (e.g. 'magic_link', 'password_reset'). */
  readonly purpose: string;
}

/**
 * Result returned by `rotateRefreshToken`, bundling the consumed old record
 * and the newly issued replacement.
 */
export interface RotateResult {
  /** The old (now consumed) token record. */
  consumed: AuthToken;
  /** The freshly issued replacement refresh token. */
  next: AuthToken;
}

/**
 * Configuration for `TokenStore`.
 */
export interface TokenStoreOptions {
  /**
   * Default TTL in milliseconds for one-time tokens.  Tokens issued without
   * an explicit `expiresInMs` fall back to this value.
   *
   * Defaults to 15 minutes (900 000 ms).  Pass `0` to disable default expiry
   * (tokens do not expire unless an explicit `expiresInMs` is provided at
   * issue time).
   */
  defaultOneTimeTtlMs?: number;

  /**
   * Default TTL in milliseconds for refresh tokens.
   *
   * Defaults to 7 days (604 800 000 ms).  Pass `0` to disable.
   */
  defaultRefreshTtlMs?: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when `consumeToken` or `rotateRefreshToken` is called with a token
 * value that does not exist in the store.
 */
export class TokenNotFoundError extends Error {
  constructor(public readonly tokenValue: string) {
    super(`Auth token not found: ${tokenValue}`);
    this.name = 'TokenNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a token has already been consumed or rotated.
 *
 * This is the primary guard against replay attacks: a second attempt to use
 * any one-time or refresh token raises this error.
 */
export class TokenAlreadyUsedError extends Error {
  constructor(
    public readonly tokenValue: string,
    public readonly usedAt: string,
  ) {
    super(`Auth token was already used at ${usedAt}: ${tokenValue}`);
    this.name = 'TokenAlreadyUsedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a token has been explicitly revoked (e.g. via logout).
 */
export class TokenRevokedError extends Error {
  constructor(
    public readonly tokenValue: string,
    public readonly revokedAt: string,
  ) {
    super(`Auth token was revoked at ${revokedAt}: ${tokenValue}`);
    this.name = 'TokenRevokedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a token's TTL has passed.
 */
export class TokenExpiredError extends Error {
  constructor(
    public readonly tokenValue: string,
    public readonly expiresAt: string,
  ) {
    super(`Auth token expired at ${expiresAt}: ${tokenValue}`);
    this.name = 'TokenExpiredError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Default TTLs ─────────────────────────────────────────────────────────────

const DEFAULT_ONE_TIME_TTL_MS = 15 * 60 * 1_000;   // 15 minutes
const DEFAULT_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

// ─── TokenStore ───────────────────────────────────────────────────────────────

/**
 * In-memory store for auth tokens that enforces one-time-use semantics and
 * refresh token rotation.
 *
 * All mutations are synchronous so there is no TOCTOU window between
 * reading a token's state and updating it.  For persistence across process
 * restarts, wrap this class or delegate to an external store — that is an
 * orchestration concern beyond this module's scope.
 *
 * @example
 * ```ts
 * const store = new TokenStore();
 *
 * // Issue a magic-link token:
 * const token = store.issueToken('user-42', 'magic_link', { expiresInMs: 10 * 60 * 1000 });
 * sendEmail(user.email, `/auth/magic?token=${token.value}`);
 *
 * // Consume on first click (idempotency is the caller's responsibility):
 * const consumed = store.consumeToken(token.value);
 * // second click:
 * store.consumeToken(token.value); // throws TokenAlreadyUsedError
 *
 * // Refresh token rotation:
 * const initial = store.issueToken('user-42', 'magic_link', { kind: 'refresh' });
 * const { next } = store.rotateRefreshToken(initial.value);
 * // now send `next.value` back to the client
 * store.rotateRefreshToken(initial.value); // throws TokenAlreadyUsedError
 *
 * // Logout:
 * store.revokeToken(next.value);
 * store.rotateRefreshToken(next.value); // throws TokenRevokedError
 * ```
 */
export class TokenStore {
  private readonly store = new Map<string, AuthToken>();
  private readonly defaultOneTimeTtlMs: number;
  private readonly defaultRefreshTtlMs: number;

  constructor(options: TokenStoreOptions = {}) {
    this.defaultOneTimeTtlMs = options.defaultOneTimeTtlMs ?? DEFAULT_ONE_TIME_TTL_MS;
    this.defaultRefreshTtlMs = options.defaultRefreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
  }

  // ─── public API ─────────────────────────────────────────────────────────────

  /**
   * Issue a new auth token and add it to the store.
   *
   * @param userId      - Identifier of the user this token belongs to.
   * @param purpose     - Free-form label ('magic_link', 'password_reset', …).
   * @param opts.kind        - `'one_time'` (default) or `'refresh'`.
   * @param opts.expiresInMs - Override the store-level default TTL. Pass `0`
   *                           to issue a non-expiring token regardless of the
   *                           store default.
   * @returns The newly issued `AuthToken` record.
   */
  issueToken(
    userId: string,
    purpose: string,
    opts: { kind?: TokenKind; expiresInMs?: number } = {},
  ): AuthToken {
    if (!userId || typeof userId !== 'string') {
      throw new TypeError('userId must be a non-empty string');
    }
    if (!purpose || typeof purpose !== 'string') {
      throw new TypeError('purpose must be a non-empty string');
    }

    const kind: TokenKind = opts.kind ?? 'one_time';
    const now = new Date();
    const issuedAt = now.toISOString();

    // Resolve TTL: explicit override → store default → no expiry (0 → undefined).
    const ttlMs =
      opts.expiresInMs !== undefined
        ? opts.expiresInMs
        : kind === 'refresh'
          ? this.defaultRefreshTtlMs
          : this.defaultOneTimeTtlMs;

    const expiresAt =
      ttlMs > 0
        ? new Date(now.getTime() + ttlMs).toISOString()
        : undefined;

    const token: AuthToken = Object.freeze({
      value: ulid(),
      kind,
      userId,
      issuedAt,
      expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
      status: 'pending' as TokenStatus,
      purpose,
    });

    this.store.set(token.value, token);
    return token;
  }

  /**
   * Look up a token record without mutating it.
   *
   * @returns The `AuthToken` snapshot, or `undefined` if not found.
   */
  findToken(value: string): AuthToken | undefined {
    if (!value) return undefined;
    return this.store.get(value);
  }

  /**
   * Consume a one-time token, permanently marking it as used.
   *
   * This is the authoritative gate for magic-link, password-reset, and
   * email-verification flows.  The token's `usedAt` timestamp is set
   * atomically before returning — any subsequent call with the same value
   * raises `TokenAlreadyUsedError`.
   *
   * @param value - The raw token string the client presented.
   * @returns The updated `AuthToken` snapshot with `status: 'used'`.
   *
   * @throws {TokenNotFoundError}   if the token does not exist.
   * @throws {TokenAlreadyUsedError} if the token was already consumed.
   * @throws {TokenRevokedError}    if the token was revoked (e.g. logout).
   * @throws {TokenExpiredError}    if the token's TTL has passed.
   */
  consumeToken(value: string): AuthToken {
    const record = this.requireRecord(value);
    this.assertConsumable(record);

    const consumed: AuthToken = Object.freeze({
      ...record,
      usedAt: new Date().toISOString(),
      status: 'used' as TokenStatus,
    });

    this.store.set(value, consumed);
    return consumed;
  }

  /**
   * Rotate a refresh token: atomically invalidate the old one and issue a
   * replacement with the same `userId` and a fresh TTL.
   *
   * This enforces one-time-use semantics on refresh tokens — replaying the
   * old token value raises `TokenAlreadyUsedError`.
   *
   * @param value - The current (unconsumed) refresh token the client holds.
   * @returns `{ consumed, next }` — the consumed old record and the new token.
   *
   * @throws {TokenNotFoundError}   if the token does not exist.
   * @throws {TokenAlreadyUsedError} if the token was already rotated or consumed.
   * @throws {TokenRevokedError}    if the token was revoked.
   * @throws {TokenExpiredError}    if the token has expired.
   */
  rotateRefreshToken(value: string): RotateResult {
    const record = this.requireRecord(value);

    if (record.kind !== 'refresh') {
      throw new TypeError(
        `rotateRefreshToken requires a 'refresh' token, got '${record.kind}'`,
      );
    }

    this.assertConsumable(record);

    // Mark old token as used — do this BEFORE issuing the new one so we
    // never have two live refresh tokens for the same session.
    const consumed: AuthToken = Object.freeze({
      ...record,
      usedAt: new Date().toISOString(),
      status: 'used' as TokenStatus,
    });
    this.store.set(value, consumed);

    // Issue replacement with same userId and purpose, fresh TTL.
    const next = this.issueToken(record.userId, record.purpose, {
      kind: 'refresh',
    });

    return { consumed, next };
  }

  /**
   * Revoke a token unconditionally, regardless of its current status.
   *
   * Idempotent: revoking an already-revoked token is a no-op.  Revoking a
   * non-existent token is also silently ignored — callers should not be
   * required to track whether a token was previously issued.
   *
   * Intended for logout flows: after `revokeToken`, any attempt to consume
   * or rotate the token raises `TokenRevokedError`.
   *
   * @param value - The token string to revoke.
   */
  revokeToken(value: string): void {
    const record = this.store.get(value);
    if (record === undefined) return; // Idempotent: already gone or never existed.
    if (record.status === 'revoked') return; // Already revoked — no-op.

    const revoked: AuthToken = Object.freeze({
      ...record,
      revokedAt: new Date().toISOString(),
      status: 'revoked' as TokenStatus,
    });

    this.store.set(value, revoked);
  }

  /**
   * Remove all token records from the store.
   *
   * Intended for test teardown or administrative full-reset flows.  Use
   * `revokeToken` for individual logouts in production paths.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Number of token records currently held in the store, including used,
   * revoked, and expired records that have not been pruned.
   */
  get size(): number {
    return this.store.size;
  }

  // ─── private helpers ────────────────────────────────────────────────────────

  /**
   * Retrieve the record for `value` or throw `TokenNotFoundError`.
   */
  private requireRecord(value: string): AuthToken {
    if (!value) throw new TokenNotFoundError(value);
    const record = this.store.get(value);
    if (record === undefined) throw new TokenNotFoundError(value);
    return record;
  }

  /**
   * Assert that a token can be consumed/rotated right now.
   *
   * The checks are ordered so that the most informative error is raised:
   *   1. Already used → `TokenAlreadyUsedError`
   *   2. Revoked      → `TokenRevokedError`
   *   3. Expired      → `TokenExpiredError`
   *
   * Ordering used/revoked before expired is intentional: the caller needs to
   * know *why* the token is invalid even if it also happens to be past its
   * TTL, and "already used" is the most actionable signal for replay detection.
   */
  private assertConsumable(record: AuthToken): void {
    if (record.status === 'used' && record.usedAt !== undefined) {
      throw new TokenAlreadyUsedError(record.value, record.usedAt);
    }

    if (record.status === 'revoked' && record.revokedAt !== undefined) {
      throw new TokenRevokedError(record.value, record.revokedAt);
    }

    if (record.expiresAt !== undefined) {
      const expiresMs = new Date(record.expiresAt).getTime();
      if (Number.isFinite(expiresMs) && Date.now() > expiresMs) {
        throw new TokenExpiredError(record.value, record.expiresAt);
      }
    }
  }
}

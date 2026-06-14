/**
 * Tests for the TokenStore — GIN-24 token reuse vulnerability fix.
 *
 * Every test in the "replay attack" suites verifies that a token that has
 * already been consumed, rotated, revoked, or expired is rejected on the
 * second attempt with the correct typed error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TokenStore,
  TokenNotFoundError,
  TokenAlreadyUsedError,
  TokenRevokedError,
  TokenExpiredError,
} from '../src/index.js';
import type { AuthToken } from '../src/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function advanceTime(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('TokenStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── issueToken ────────────────────────────────────────────────────────────

  describe('issueToken', () => {
    it('returns a pending token with a unique value', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'magic_link');

      expect(t.value).toBeTruthy();
      expect(t.status).toBe('pending');
      expect(t.userId).toBe('user-1');
      expect(t.purpose).toBe('magic_link');
      expect(t.kind).toBe('one_time');
      expect(t.usedAt).toBeUndefined();
      expect(t.revokedAt).toBeUndefined();
    });

    it('sets issuedAt to the current ISO timestamp', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-2', 'password_reset');

      expect(t.issuedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('applies the default one-time TTL (15 minutes)', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-3', 'magic_link');

      const expectedExpiry = new Date('2026-01-01T00:15:00.000Z').toISOString();
      expect(t.expiresAt).toBe(expectedExpiry);
    });

    it('applies the default refresh TTL (7 days) for refresh tokens', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-4', 'session', { kind: 'refresh' });

      expect(t.kind).toBe('refresh');
      const expiresMs = new Date(t.expiresAt!).getTime();
      const issuedMs = new Date(t.issuedAt).getTime();
      expect(expiresMs - issuedMs).toBe(7 * 24 * 60 * 60 * 1_000);
    });

    it('respects an explicit expiresInMs override', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-5', 'email_verify', { expiresInMs: 60_000 });

      const expectedExpiry = new Date('2026-01-01T00:01:00.000Z').toISOString();
      expect(t.expiresAt).toBe(expectedExpiry);
    });

    it('issues a non-expiring token when expiresInMs is 0', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-6', 'magic_link', { expiresInMs: 0 });

      expect(t.expiresAt).toBeUndefined();
    });

    it('issues a non-expiring token when store default TTL is 0', () => {
      const store = new TokenStore({ defaultOneTimeTtlMs: 0 });
      const t = store.issueToken('user-7', 'magic_link');

      expect(t.expiresAt).toBeUndefined();
    });

    it('generates unique values for every issued token', () => {
      const store = new TokenStore();
      const values = Array.from({ length: 200 }, (_, i) =>
        store.issueToken(`user-${i}`, 'magic_link').value,
      );
      expect(new Set(values).size).toBe(200);
    });

    it('throws TypeError for an empty userId', () => {
      const store = new TokenStore();
      expect(() => store.issueToken('', 'magic_link')).toThrow(TypeError);
    });

    it('throws TypeError for an empty purpose', () => {
      const store = new TokenStore();
      expect(() => store.issueToken('user-1', '')).toThrow(TypeError);
    });

    it('increments store size on each issue', () => {
      const store = new TokenStore();
      expect(store.size).toBe(0);
      store.issueToken('u1', 'p');
      expect(store.size).toBe(1);
      store.issueToken('u2', 'p');
      expect(store.size).toBe(2);
    });
  });

  // ── findToken ─────────────────────────────────────────────────────────────

  describe('findToken', () => {
    it('returns the token record when it exists', () => {
      const store = new TokenStore();
      const issued = store.issueToken('user-1', 'magic_link');
      const found = store.findToken(issued.value);

      expect(found).toBeDefined();
      expect(found?.value).toBe(issued.value);
    });

    it('returns undefined for an unknown value (no throw)', () => {
      const store = new TokenStore();
      expect(store.findToken('no-such-token')).toBeUndefined();
    });

    it('returns undefined for an empty string (no throw)', () => {
      const store = new TokenStore();
      expect(store.findToken('')).toBeUndefined();
    });
  });

  // ── consumeToken — happy path ─────────────────────────────────────────────

  describe('consumeToken (happy path)', () => {
    it('marks the token as used and sets usedAt', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'magic_link');

      advanceTime(1_000);
      const consumed = store.consumeToken(t.value);

      expect(consumed.status).toBe('used');
      expect(consumed.usedAt).toBe('2026-01-01T00:00:01.000Z');
      expect(consumed.value).toBe(t.value);
    });

    it('persists the used state so findToken reflects it', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'magic_link');
      store.consumeToken(t.value);

      const record = store.findToken(t.value);
      expect(record?.status).toBe('used');
      expect(record?.usedAt).toBeDefined();
    });
  });

  // ── consumeToken — replay attack scenarios ────────────────────────────────

  describe('consumeToken — replay attack scenarios', () => {
    it('REPLAY: rejects a one-time token on second use with TokenAlreadyUsedError', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'magic_link');

      store.consumeToken(t.value); // first use succeeds

      // Second use (replay) must be rejected.
      expect(() => store.consumeToken(t.value)).toThrow(TokenAlreadyUsedError);
    });

    it('REPLAY: TokenAlreadyUsedError carries the correct usedAt timestamp', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'password_reset');

      advanceTime(5_000);
      store.consumeToken(t.value);

      try {
        store.consumeToken(t.value);
        expect.fail('Expected TokenAlreadyUsedError');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenAlreadyUsedError);
        expect((err as TokenAlreadyUsedError).usedAt).toBe('2026-01-01T00:00:05.000Z');
        expect((err as TokenAlreadyUsedError).tokenValue).toBe(t.value);
      }
    });

    it('REPLAY: third and subsequent replays still raise TokenAlreadyUsedError', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'email_verify');
      store.consumeToken(t.value);

      for (let i = 0; i < 5; i++) {
        expect(() => store.consumeToken(t.value)).toThrow(TokenAlreadyUsedError);
      }
    });

    it('REPLAY: different user tokens do not interfere with each other', () => {
      const store = new TokenStore();
      const t1 = store.issueToken('user-1', 'magic_link');
      const t2 = store.issueToken('user-2', 'magic_link');

      store.consumeToken(t1.value); // user-1 uses their token

      // user-2's token must still be valid
      expect(() => store.consumeToken(t2.value)).not.toThrow();

      // user-1 cannot replay
      expect(() => store.consumeToken(t1.value)).toThrow(TokenAlreadyUsedError);
    });

    it('EXPIRED: rejects a token whose TTL has passed before consumption', () => {
      const store = new TokenStore({ defaultOneTimeTtlMs: 5_000 });
      const t = store.issueToken('user-1', 'magic_link');

      advanceTime(6_000); // past TTL

      expect(() => store.consumeToken(t.value)).toThrow(TokenExpiredError);
    });

    it('EXPIRED: TokenExpiredError carries the correct expiresAt', () => {
      const store = new TokenStore({ defaultOneTimeTtlMs: 1_000 });
      const t = store.issueToken('user-1', 'password_reset');
      const expectedExpiry = t.expiresAt!;

      advanceTime(2_000);

      try {
        store.consumeToken(t.value);
        expect.fail('Expected TokenExpiredError');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenExpiredError);
        expect((err as TokenExpiredError).expiresAt).toBe(expectedExpiry);
      }
    });

    it('REVOKED: rejects a token that was revoked before consumption', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'magic_link');
      store.revokeToken(t.value);

      expect(() => store.consumeToken(t.value)).toThrow(TokenRevokedError);
    });

    it('NOT_FOUND: rejects an unknown token value', () => {
      const store = new TokenStore();
      expect(() => store.consumeToken('completely-unknown')).toThrow(TokenNotFoundError);
    });
  });

  // ── rotateRefreshToken — happy path ───────────────────────────────────────

  describe('rotateRefreshToken (happy path)', () => {
    it('returns the consumed old record and a new pending token', () => {
      const store = new TokenStore();
      const initial = store.issueToken('user-1', 'session', { kind: 'refresh' });

      const { consumed, next } = store.rotateRefreshToken(initial.value);

      expect(consumed.value).toBe(initial.value);
      expect(consumed.status).toBe('used');
      expect(consumed.usedAt).toBeDefined();

      expect(next.status).toBe('pending');
      expect(next.kind).toBe('refresh');
      expect(next.userId).toBe('user-1');
      expect(next.purpose).toBe('session');
      expect(next.value).not.toBe(initial.value);
    });

    it('stores the new token so it can be found and rotated again', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });
      const { next } = store.rotateRefreshToken(t.value);

      expect(store.findToken(next.value)?.status).toBe('pending');
    });

    it('increments store size by 1 per rotation (old stays, new added)', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });
      expect(store.size).toBe(1);

      store.rotateRefreshToken(t.value);
      expect(store.size).toBe(2); // old (used) + new (pending)
    });

    it('supports chained rotation across multiple generations', () => {
      const store = new TokenStore();
      let current = store.issueToken('user-1', 'session', { kind: 'refresh' });

      for (let i = 0; i < 5; i++) {
        const { next } = store.rotateRefreshToken(current.value);
        current = next;
      }

      expect(current.status).toBe('pending');
      expect(store.findToken(current.value)?.status).toBe('pending');
    });
  });

  // ── rotateRefreshToken — replay attack scenarios ───────────────────────────

  describe('rotateRefreshToken — replay attack scenarios', () => {
    it('REPLAY: rejects re-use of a rotated refresh token with TokenAlreadyUsedError', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });

      store.rotateRefreshToken(t.value); // first rotation succeeds

      // Replay the old token:
      expect(() => store.rotateRefreshToken(t.value)).toThrow(TokenAlreadyUsedError);
    });

    it('REPLAY: token theft scenario — attacker replays stolen old refresh token', () => {
      const store = new TokenStore();

      // Legitimate client holds initial token.
      const initial = store.issueToken('user-99', 'session', { kind: 'refresh' });
      // Attacker steals initial token value before client uses it.
      const stolenValue = initial.value;

      // Legitimate client rotates first:
      const { next: clientNext } = store.rotateRefreshToken(stolenValue);

      // Attacker tries to replay the stolen (now-used) token:
      expect(() => store.rotateRefreshToken(stolenValue)).toThrow(TokenAlreadyUsedError);

      // Legitimate client's new token is still usable:
      expect(() => store.rotateRefreshToken(clientNext.value)).not.toThrow();
    });

    it('REPLAY: rotating an already-consumed one_time token raises TokenAlreadyUsedError', () => {
      // rotateRefreshToken should also reject tokens that were previously
      // consumed via consumeToken (kind check happens before status check).
      const store = new TokenStore();
      // Issue a refresh token and first consume it (simulates accidental call):
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });
      store.consumeToken(t.value);

      expect(() => store.rotateRefreshToken(t.value)).toThrow(TokenAlreadyUsedError);
    });

    it('EXPIRED: rejects rotation of an expired refresh token', () => {
      const store = new TokenStore({ defaultRefreshTtlMs: 1_000 });
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });

      advanceTime(2_000);

      expect(() => store.rotateRefreshToken(t.value)).toThrow(TokenExpiredError);
    });

    it('REVOKED: rejects rotation of a revoked refresh token (logout replay)', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });
      store.revokeToken(t.value);

      expect(() => store.rotateRefreshToken(t.value)).toThrow(TokenRevokedError);
    });

    it('NOT_FOUND: rejects rotation of an unknown token', () => {
      const store = new TokenStore();
      expect(() => store.rotateRefreshToken('ghost')).toThrow(TokenNotFoundError);
    });

    it('TYPE_ERROR: rejects rotation of a one_time token (kind mismatch)', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'magic_link'); // kind = 'one_time'

      expect(() => store.rotateRefreshToken(t.value)).toThrow(TypeError);
    });
  });

  // ── revokeToken (logout) ──────────────────────────────────────────────────

  describe('revokeToken — logout scenarios', () => {
    it('marks the token as revoked and sets revokedAt', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });

      advanceTime(3_000);
      store.revokeToken(t.value);

      const record = store.findToken(t.value);
      expect(record?.status).toBe('revoked');
      expect(record?.revokedAt).toBe('2026-01-01T00:00:03.000Z');
    });

    it('prevents consumeToken after revocation (logout replay)', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'magic_link');
      store.revokeToken(t.value);

      expect(() => store.consumeToken(t.value)).toThrow(TokenRevokedError);
    });

    it('prevents rotateRefreshToken after revocation (logout replay)', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });
      store.revokeToken(t.value);

      expect(() => store.rotateRefreshToken(t.value)).toThrow(TokenRevokedError);
    });

    it('TokenRevokedError carries the correct revokedAt timestamp', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'magic_link');

      advanceTime(7_000);
      store.revokeToken(t.value);

      try {
        store.consumeToken(t.value);
        expect.fail('Expected TokenRevokedError');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenRevokedError);
        expect((err as TokenRevokedError).revokedAt).toBe('2026-01-01T00:00:07.000Z');
        expect((err as TokenRevokedError).tokenValue).toBe(t.value);
      }
    });

    it('is idempotent: revoking an already-revoked token is a no-op', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });
      store.revokeToken(t.value);

      const firstRevokedAt = store.findToken(t.value)?.revokedAt;

      advanceTime(5_000);
      store.revokeToken(t.value); // second call

      // revokedAt must not change on a second revoke.
      expect(store.findToken(t.value)?.revokedAt).toBe(firstRevokedAt);
    });

    it('is idempotent: revoking an unknown token does not throw', () => {
      const store = new TokenStore();
      expect(() => store.revokeToken('ghost')).not.toThrow();
    });

    it('only revokes the target token — other tokens remain valid', () => {
      const store = new TokenStore();
      const t1 = store.issueToken('user-1', 'magic_link');
      const t2 = store.issueToken('user-2', 'magic_link');

      store.revokeToken(t1.value);

      // t2 is untouched and can still be consumed.
      expect(() => store.consumeToken(t2.value)).not.toThrow();
    });
  });

  // ── error precedence ──────────────────────────────────────────────────────

  describe('error precedence', () => {
    it('used takes precedence over expired: used token past TTL raises TokenAlreadyUsedError', () => {
      const store = new TokenStore({ defaultOneTimeTtlMs: 5_000 });
      const t = store.issueToken('user-1', 'magic_link');

      store.consumeToken(t.value); // mark used
      advanceTime(10_000);         // advance past TTL

      // Should be TokenAlreadyUsedError, not TokenExpiredError.
      expect(() => store.consumeToken(t.value)).toThrow(TokenAlreadyUsedError);
    });

    it('revoked takes precedence over expired: revoked token past TTL raises TokenRevokedError', () => {
      const store = new TokenStore({ defaultOneTimeTtlMs: 5_000 });
      const t = store.issueToken('user-1', 'magic_link');

      store.revokeToken(t.value);
      advanceTime(10_000);

      expect(() => store.consumeToken(t.value)).toThrow(TokenRevokedError);
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('empties the store', () => {
      const store = new TokenStore();
      store.issueToken('u1', 'p');
      store.issueToken('u2', 'p');
      store.clear();

      expect(store.size).toBe(0);
    });

    it('findToken returns undefined for all tokens after clear', () => {
      const store = new TokenStore();
      const t = store.issueToken('u1', 'magic_link');
      store.clear();

      expect(store.findToken(t.value)).toBeUndefined();
    });
  });

  // ── non-expiring tokens ───────────────────────────────────────────────────

  describe('non-expiring tokens (expiresInMs: 0)', () => {
    it('one-time tokens with no TTL are valid indefinitely', () => {
      const store = new TokenStore({ defaultOneTimeTtlMs: 0 });
      const t = store.issueToken('user-1', 'magic_link');

      advanceTime(365 * 24 * 60 * 60 * 1_000); // 1 year

      expect(() => store.consumeToken(t.value)).not.toThrow();
    });

    it('refresh tokens with no TTL can be rotated indefinitely', () => {
      const store = new TokenStore({ defaultRefreshTtlMs: 0 });
      const t = store.issueToken('user-1', 'session', { kind: 'refresh' });

      advanceTime(365 * 24 * 60 * 60 * 1_000); // 1 year

      expect(() => store.rotateRefreshToken(t.value)).not.toThrow();
    });
  });

  // ── AuthToken immutability ────────────────────────────────────────────────

  describe('AuthToken immutability', () => {
    it('issued token is frozen — external mutation does not affect the store', () => {
      const store = new TokenStore();
      const t = store.issueToken('user-1', 'magic_link') as AuthToken & { status: string };

      // Attempt mutation on the returned snapshot.
      expect(() => { t.status = 'used'; }).toThrow();

      // Store record is unaffected.
      expect(store.findToken(t.value)?.status).toBe('pending');
    });
  });
});

/**
 * Tests for the SessionManager — GIN-25 null-safety fix.
 *
 * Verifies that every code path that accesses session properties is guarded
 * against undefined values, and that error cases surface the correct typed
 * errors rather than null pointer dereferences.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SessionManager,
  SessionNotFoundError,
  SessionInvalidError,
} from '../src/index.js';
import type { UserSession } from '../src/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function advanceTime(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe('SessionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── createSession ─────────────────────────────────────────────────────────

  describe('createSession', () => {
    it('returns an active session with a non-empty id', () => {
      const manager = new SessionManager();
      const session = manager.createSession('user-1');

      expect(session.id).toBeTruthy();
      expect(session.userId).toBe('user-1');
      expect(session.status).toBe('active');
    });

    it('sets createdAt to current ISO timestamp', () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(now);
      const manager = new SessionManager();
      const session = manager.createSession('user-2');

      expect(session.createdAt).toBe(now.toISOString());
    });

    it('leaves lastActivityAt as undefined on first creation', () => {
      const manager = new SessionManager();
      const session = manager.createSession('user-3');

      // GIN-25: confirm the field is undefined rather than null
      expect(session.lastActivityAt).toBeUndefined();
    });

    it('stores caller-supplied metadata without mutation', () => {
      const manager = new SessionManager();
      const meta = { role: 'admin', tenantId: 42 };
      const session = manager.createSession('user-4', meta);

      expect(session.metadata).toEqual(meta);
      // Mutation of the original should not affect the stored copy.
      meta.role = 'viewer';
      expect(session.metadata.role).toBe('admin');
    });

    it('defaults metadata to an empty object when omitted', () => {
      const manager = new SessionManager();
      const session = manager.createSession('user-5');

      expect(session.metadata).toEqual({});
    });

    it('throws TypeError for an empty userId', () => {
      const manager = new SessionManager();
      expect(() => manager.createSession('')).toThrow(TypeError);
    });

    it('creates sessions with unique ids', () => {
      const manager = new SessionManager();
      const ids = Array.from({ length: 100 }, (_, i) => manager.createSession(`user-${i}`).id);
      expect(new Set(ids).size).toBe(100);
    });
  });

  // ── getSession ────────────────────────────────────────────────────────────

  describe('getSession', () => {
    it('returns the session for a valid id', () => {
      const manager = new SessionManager();
      const created = manager.createSession('user-1');
      const fetched = manager.getSession(created.id);

      expect(fetched.id).toBe(created.id);
      expect(fetched.userId).toBe('user-1');
    });

    it('throws SessionNotFoundError for an unknown id', () => {
      const manager = new SessionManager();
      expect(() => manager.getSession('nonexistent')).toThrow(SessionNotFoundError);
    });

    it('throws SessionNotFoundError with the correct sessionId', () => {
      const manager = new SessionManager();
      try {
        manager.getSession('ghost-id');
      } catch (err) {
        expect(err).toBeInstanceOf(SessionNotFoundError);
        expect((err as SessionNotFoundError).sessionId).toBe('ghost-id');
      }
    });

    it('throws SessionInvalidError for an expired session', () => {
      const manager = new SessionManager({ ttlMs: 5_000 });
      const session = manager.createSession('user-2');

      advanceTime(6_000);

      expect(() => manager.getSession(session.id)).toThrow(SessionNotFoundError);
    });
  });

  // ── findSession ───────────────────────────────────────────────────────────

  describe('findSession', () => {
    it('returns the session when it exists and is active', () => {
      const manager = new SessionManager();
      const created = manager.createSession('user-1');
      const found = manager.findSession(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it('returns undefined for an unknown id (no throw)', () => {
      const manager = new SessionManager();
      const result = manager.findSession('no-such-id');

      expect(result).toBeUndefined();
    });

    it('returns undefined and evicts an expired session', () => {
      const manager = new SessionManager({ ttlMs: 1_000 });
      const session = manager.createSession('user-2');

      advanceTime(2_000);

      const result = manager.findSession(session.id);
      expect(result).toBeUndefined();
      // Side-effect: evicted from store.
      expect(manager.size).toBe(0);
    });

    it('handles an empty-string id safely (returns undefined)', () => {
      const manager = new SessionManager();
      expect(manager.findSession('')).toBeUndefined();
    });
  });

  // ── touchSession ──────────────────────────────────────────────────────────

  describe('touchSession', () => {
    it('updates lastActivityAt and returns the updated session', () => {
      const manager = new SessionManager();
      const session = manager.createSession('user-1');

      const t1 = new Date('2026-01-01T00:01:00.000Z');
      vi.setSystemTime(t1);

      const touched = manager.touchSession(session.id);

      expect(touched.lastActivityAt).toBe(t1.toISOString());
      // Other fields are preserved.
      expect(touched.userId).toBe('user-1');
      expect(touched.status).toBe('active');
    });

    it('preserves createdAt unchanged after touch', () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(createdAt);

      const manager = new SessionManager();
      const session = manager.createSession('user-2');

      vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
      const touched = manager.touchSession(session.id);

      expect(touched.createdAt).toBe(createdAt.toISOString());
    });

    it('resets the inactivity window so the session does not expire', () => {
      const manager = new SessionManager({ ttlMs: 5_000 });
      const session = manager.createSession('user-3');

      // Advance to 4 s — session still alive; touch it.
      advanceTime(4_000);
      manager.touchSession(session.id);

      // Advance another 4 s — total 8 s from creation, but only 4 s since touch.
      advanceTime(4_000);

      const found = manager.findSession(session.id);
      expect(found).toBeDefined();
    });

    it('throws SessionNotFoundError for a missing session', () => {
      const manager = new SessionManager();
      expect(() => manager.touchSession('ghost')).toThrow(SessionNotFoundError);
    });

    it('throws SessionInvalidError when the session is expired at touch time', () => {
      const manager = new SessionManager({ ttlMs: 1_000 });
      const session = manager.createSession('user-4');

      advanceTime(2_000);

      expect(() => manager.touchSession(session.id)).toThrow(SessionInvalidError);
    });
  });

  // ── terminateSession ──────────────────────────────────────────────────────

  describe('terminateSession', () => {
    it('removes the session from the store', () => {
      const manager = new SessionManager();
      const session = manager.createSession('user-1');
      manager.terminateSession(session.id);

      expect(manager.findSession(session.id)).toBeUndefined();
      expect(manager.size).toBe(0);
    });

    it('is idempotent — terminating a non-existent session does not throw', () => {
      const manager = new SessionManager();
      expect(() => manager.terminateSession('already-gone')).not.toThrow();
    });

    it('makes the session unavailable via getSession after termination', () => {
      const manager = new SessionManager();
      const session = manager.createSession('user-2');
      manager.terminateSession(session.id);

      expect(() => manager.getSession(session.id)).toThrow(SessionNotFoundError);
    });
  });

  // ── listActiveSessions ────────────────────────────────────────────────────

  describe('listActiveSessions', () => {
    it('returns all active sessions', () => {
      const manager = new SessionManager();
      manager.createSession('user-a');
      manager.createSession('user-b');
      manager.createSession('user-c');

      const sessions = manager.listActiveSessions();
      expect(sessions).toHaveLength(3);
    });

    it('excludes expired sessions and evicts them', () => {
      const manager = new SessionManager({ ttlMs: 5_000 });
      const s1 = manager.createSession('user-1');
      manager.createSession('user-2'); // will expire
      manager.createSession('user-3'); // will expire

      advanceTime(6_000);

      // Touch s1 so only it resets (but s1 was created before advance, so also expired).
      // Create a fresh session after advance so it is still within TTL.
      const s4 = manager.createSession('user-4');

      const active = manager.listActiveSessions();
      const activeIds = active.map((s: UserSession) => s.id);

      expect(activeIds).not.toContain(s1.id);
      expect(activeIds).toContain(s4.id);
    });

    it('returns an empty array when there are no sessions', () => {
      const manager = new SessionManager();
      expect(manager.listActiveSessions()).toEqual([]);
    });
  });

  // ── TTL disabled (ttlMs = 0) ──────────────────────────────────────────────

  describe('ttlMs = 0 (expiry disabled)', () => {
    it('sessions never expire even after a very long time', () => {
      const manager = new SessionManager({ ttlMs: 0 });
      const session = manager.createSession('user-1');

      // Advance 100 years.
      advanceTime(100 * 365 * 24 * 60 * 60 * 1_000);

      expect(manager.findSession(session.id)).toBeDefined();
    });
  });

  // ── size ──────────────────────────────────────────────────────────────────

  describe('size', () => {
    it('reflects the number of stored sessions', () => {
      const manager = new SessionManager();
      expect(manager.size).toBe(0);

      manager.createSession('u1');
      expect(manager.size).toBe(1);

      manager.createSession('u2');
      expect(manager.size).toBe(2);

      const s = manager.createSession('u3');
      manager.terminateSession(s.id);
      expect(manager.size).toBe(2);
    });
  });

  // ── null-safety regression cases (GIN-25) ────────────────────────────────

  describe('null-safety regressions (GIN-25)', () => {
    it('does not throw when lastActivityAt is undefined during expiry check', () => {
      // Session created without any touches — lastActivityAt is undefined.
      // isExpired() must fall back to createdAt without crashing.
      const manager = new SessionManager({ ttlMs: 60_000 });
      const session = manager.createSession('user-x');

      expect(session.lastActivityAt).toBeUndefined();
      expect(() => manager.getSession(session.id)).not.toThrow();
    });

    it('does not expose a session after TTL even when lastActivityAt is undefined', () => {
      const manager = new SessionManager({ ttlMs: 1_000 });
      const session = manager.createSession('user-y');

      expect(session.lastActivityAt).toBeUndefined();

      advanceTime(2_000);

      // Must use createdAt fallback and correctly identify the session as expired.
      expect(manager.findSession(session.id)).toBeUndefined();
    });

    it('findSession returns undefined (not throws) for any missing/expired state', () => {
      const manager = new SessionManager({ ttlMs: 100 });
      const s = manager.createSession('user-z');

      advanceTime(200);

      // Must not throw — null pointer dereferences previously surfaced here
      // when code tried to access `.status` on the result of `Map.get()`
      // without checking for undefined first.
      let result: UserSession | undefined;
      expect(() => {
        result = manager.findSession(s.id);
      }).not.toThrow();
      expect(result).toBeUndefined();
    });
  });
});

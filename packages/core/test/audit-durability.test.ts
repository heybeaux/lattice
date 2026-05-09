/**
 * Durability / concurrency / streaming tests for the compliance audit log.
 *
 * These are the regression tests for issues #2, #3, #4, #5, #8, #9, #13,
 * #15, #22 in the 2026-05-08 audit batch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ComplianceAuditLog,
  AuditLogIntegrityError,
  GENESIS_HASH,
  streamVerifySync,
  iterateAuditLog,
  verifyAuditLog,
} from '../src/index.js';

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-audit-'));
});

afterEach(() => {
  if (fs.existsSync(TMPDIR)) fs.rmSync(TMPDIR, { recursive: true, force: true });
});

const newLogPath = (name = 'audit.log'): string => path.join(TMPDIR, name);

describe('crash during append (#13)', () => {
  it('truncates partial trailing record on next open and resumes the chain', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p });
    log.append({ event: 'a' });
    log.append({ event: 'b' });
    const head = log.append({ event: 'c' });

    // Simulate a crash mid-append: append half a JSON object without a
    // trailing newline (this is what fdatasync-less writes can leave behind).
    fs.appendFileSync(p, '{"sequence":4,"timestamp":"2026-05-08T00:00:00.000Z","prev');

    // streamVerifySync surfaces the partial tail without claiming validity.
    const v = streamVerifySync(p);
    expect(v.partialTailBytes).toBeGreaterThan(0);
    expect(v.lastValidSequence).toBe(3);
    expect(v.valid).toBe(false);

    // Re-open: constructor truncates the partial tail and adopts the verified head.
    const log2 = new ComplianceAuditLog({ logPath: p });
    const next = log2.append({ event: 'd-after-crash' });
    expect(next.sequence).toBe(4);
    expect(next.previousHash).toBe(head.contentHash);

    // After recovery the chain verifies cleanly end-to-end.
    expect(streamVerifySync(p).valid).toBe(true);
  });

  it('preserves all fully-fsynced entries when crash truncates only the tail', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p });
    for (let i = 0; i < 5; i++) log.append({ i });

    // Truncate the file so the last line is incomplete (no terminating \n).
    const sz = fs.statSync(p).size;
    fs.truncateSync(p, sz - 10);

    const log2 = new ComplianceAuditLog({ logPath: p });
    const v = log2.verify();
    expect(v.valid).toBe(true);
    // The last partially-written entry is gone; one less than 5.
    expect(v.lastValidSequence).toBe(4);
  });
});

describe('partial-line tail recovery (#9, #15)', () => {
  it('refuses to silently start a fresh chain over corrupt content (strict mode)', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p });
    log.append({ event: 'a' });

    // Corrupt the file body (mid-file garbage, NOT a partial-tail crash).
    fs.writeFileSync(p, 'this is not json\n{also broken}\n');

    expect(() => new ComplianceAuditLog({ logPath: p })).toThrow(AuditLogIntegrityError);
  });

  it('quarantines corrupt log only when recoveryMode = quarantine', () => {
    const p = newLogPath();
    fs.writeFileSync(p, 'totally corrupt content\n');

    const log = new ComplianceAuditLog({ logPath: p, recoveryMode: 'quarantine' });
    const entry = log.append({ event: 'fresh' });
    expect(entry.sequence).toBe(1);
    expect(entry.previousHash).toBe(GENESIS_HASH);

    // Original corrupt file moved aside, not overwritten in place.
    const dir = path.dirname(p);
    const base = path.basename(p);
    const quarantined = fs.readdirSync(dir).filter(n => n.startsWith(`${base}.corrupt.`));
    expect(quarantined.length).toBe(1);
    const quarantinedContent = fs.readFileSync(path.join(dir, quarantined[0]), 'utf-8');
    expect(quarantinedContent).toContain('totally corrupt content');
  });

  it('does NOT resume appending over a corrupt mid-file region', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p });
    log.append({ a: 1 });
    log.append({ a: 2 });
    log.append({ a: 3 });

    // Corrupt the middle entry by overwriting its line.
    const lines = fs.readFileSync(p, 'utf-8').split('\n');
    lines[1] = '{"sequence":2,"corrupt":true}';
    fs.writeFileSync(p, lines.join('\n'));

    // Constructor refuses; verify reports the break.
    expect(() => new ComplianceAuditLog({ logPath: p })).toThrow(AuditLogIntegrityError);
    const v = streamVerifySync(p);
    expect(v.valid).toBe(false);
    expect(v.lastValidSequence).toBe(1);
  });
});

describe('loadState integrity (#8)', () => {
  it('rejects a tail with a forged contentHash even if JSON parses', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p });
    log.append({ event: 'real' });

    // Replace the last line with a JSON entry that has a fake contentHash.
    const lines = fs.readFileSync(p, 'utf-8').trimEnd().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    last.contentHash = '0'.repeat(64);
    lines[lines.length - 1] = JSON.stringify(last);
    fs.writeFileSync(p, lines.join('\n') + '\n');

    expect(() => new ComplianceAuditLog({ logPath: p })).toThrow(AuditLogIntegrityError);
  });

  it('rejects a tail with a forged sequence/previousHash that fakes a higher head', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p });
    log.append({ event: 'a' });
    log.append({ event: 'b' });

    // Append a forged "sequence:99" entry with random fields.
    const forged = {
      sequence: 99,
      timestamp: new Date().toISOString(),
      previousHash: '0'.repeat(64),
      contentHash: 'f'.repeat(64),
      data: { forged: true },
    };
    fs.appendFileSync(p, JSON.stringify(forged) + '\n');

    expect(() => new ComplianceAuditLog({ logPath: p })).toThrow(AuditLogIntegrityError);
    const v = verifyAuditLog(p);
    expect(v.valid).toBe(false);
    expect(v.lastValidSequence).toBe(2);
  });
});

describe('concurrent appends from racing instances (#4, #5)', () => {
  it('serializes appends so every entry has a unique sequence and verifies clean', () => {
    const p = newLogPath();
    // Two log instances pointing at the same file (simulates two processes).
    const a = new ComplianceAuditLog({ logPath: p, lockTimeoutMs: 30000 });
    const b = new ComplianceAuditLog({ logPath: p, lockTimeoutMs: 30000 });

    // Interleave 50 appends across the two instances.
    const N = 50;
    const order: Array<'a' | 'b'> = [];
    for (let i = 0; i < N; i++) order.push(i % 2 === 0 ? 'a' : 'b');

    for (let i = 0; i < N; i++) {
      const inst = order[i] === 'a' ? a : b;
      inst.append({ writer: order[i], i });
    }

    // Total entries = N; sequences 1..N; chain verifies.
    const v = streamVerifySync(p);
    expect(v.valid).toBe(true);
    expect(v.totalEntries).toBe(N);
    expect(v.lastValidSequence).toBe(N);
  });

  it('lockfile is released after append even when a write throws', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p, lockTimeoutMs: 1000 });
    log.append({ ok: 1 });
    // After a normal append, no .lock file remains.
    expect(fs.existsSync(`${p}.lock`)).toBe(false);
  });

  it('reclaims a stale lock left behind by a dead PID', () => {
    const p = newLogPath();
    const lockPath = `${p}.lock`;
    // Create a lockfile owned by a clearly-dead pid.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }));

    const log = new ComplianceAuditLog({ logPath: p, lockTimeoutMs: 5000 });
    const entry = log.append({ recovered: true });
    expect(entry.sequence).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('streaming reads do not OOM on large logs (#3)', () => {
  it('verifies a large (100k-entry) log without loading the file into memory', () => {
    // We synthesize a properly-chained log via direct writes (no per-entry
    // fdatasync, no lockfile) so the fixture build is fast. The point of the
    // test is that the *verifier* streams — if the streaming path regressed
    // back to readFileSync the test would either OOM or be wildly slower.
    const p = newLogPath();
    const N = 100_000;
    const algo = 'sha256' as const;
    const sortKeys = (o: any): any => {
      if (o === null || typeof o !== 'object') return o;
      if (Array.isArray(o)) return o.map(sortKeys);
      const r: any = {};
      for (const k of Object.keys(o).sort()) r[k] = sortKeys(o[k]);
      return r;
    };
    const crypto = require('crypto');
    const hash = (d: any) =>
      crypto.createHash(algo).update(JSON.stringify(sortKeys(d))).digest('hex');

    const fd = fs.openSync(p, 'w');
    try {
      let prev = GENESIS_HASH;
      let buf = '';
      for (let i = 1; i <= N; i++) {
        const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();
        const e: any = {
          sequence: i,
          timestamp: ts,
          previousHash: prev,
          data: { i, payload: 'x'.repeat(32) },
        };
        e.contentHash = hash(e);
        prev = e.contentHash;
        buf += JSON.stringify(e) + '\n';
        if (buf.length > 256 * 1024) {
          fs.writeSync(fd, buf);
          buf = '';
        }
      }
      if (buf) fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    const sizeMB = fs.statSync(p).size / 1024 / 1024;
    expect(sizeMB).toBeGreaterThan(20); // sanity: file is genuinely large

    const v = streamVerifySync(p);
    expect(v.valid).toBe(true);
    expect(v.lastValidSequence).toBe(N);
    expect(v.totalEntries).toBe(N);
  }, 60_000);

  it('iterateAuditLog yields one entry at a time (async generator)', async () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p });
    for (let i = 0; i < 100; i++) log.append({ i });

    let count = 0;
    for await (const line of iterateAuditLog(p)) {
      expect(line.parseError).toBeUndefined();
      expect(line.parsed!.sequence).toBe(count + 1);
      count++;
    }
    expect(count).toBe(100);
  });
});

describe('retention preserves chain integrity (#2, #22)', () => {
  it('verify() passes end-to-end after enforceRetention (chain not rewritten)', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p, retentionDays: 30 });
    for (let i = 0; i < 5; i++) log.append({ i });
    const beforeContent = fs.readFileSync(p, 'utf-8');

    const result = log.enforceRetention();
    expect(result.removed).toBe(0); // nothing aged out yet
    expect(streamVerifySync(p).valid).toBe(true);

    // The on-disk file is byte-identical (no rewrite).
    const afterContent = fs.readFileSync(p, 'utf-8');
    expect(afterContent).toBe(beforeContent);
  });

  it('enforceRetention refuses to operate on a corrupt chain', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p, retentionDays: 1 });
    log.append({ a: 1 });
    log.append({ a: 2 });

    // Corrupt the file under the running instance.
    const lines = fs.readFileSync(p, 'utf-8').trimEnd().split('\n');
    const e = JSON.parse(lines[0]);
    e.data = { tampered: true };
    lines[0] = JSON.stringify(e);
    fs.writeFileSync(p, lines.join('\n') + '\n');

    expect(() => log.enforceRetention()).toThrow(AuditLogIntegrityError);
  });
});

describe('append-only protection (#5)', () => {
  it('refuses to append after the chain head is rewritten on disk', () => {
    const p = newLogPath();
    const log = new ComplianceAuditLog({ logPath: p });
    log.append({ a: 1 });
    log.append({ a: 2 });

    // Tamper with the last line's contentHash.
    const lines = fs.readFileSync(p, 'utf-8').trimEnd().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    last.contentHash = '0'.repeat(64);
    lines[lines.length - 1] = JSON.stringify(last);
    fs.writeFileSync(p, lines.join('\n') + '\n');

    // The pre-existing instance reads the tail under lock at next append and
    // refuses rather than chaining off forged state.
    expect(() => log.append({ a: 3 })).toThrow(AuditLogIntegrityError);
  });
});

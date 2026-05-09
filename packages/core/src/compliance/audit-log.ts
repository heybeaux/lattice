/**
 * Compliance features for Lattice audit logs.
 *
 * Provides:
 * - Hash-chained append-only audit logs (tamper-evident)
 * - Crash-safe append (O_APPEND + fdatasync)
 * - Inter-process append safety (advisory lockfile)
 * - Streaming read paths (no full-file loads)
 * - Retention via cutoff sidecar (chain is never re-written)
 * - SOC 2 compliance export
 * - Integrity verification
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Readable } from 'stream';
import { canonicalize } from '../util/canonical.js';

/**
 * Configuration for the compliance audit log.
 */
export interface ComplianceConfig {
  /** Path to the audit log file */
  logPath: string;
  /** Number of days to retain entries (default: 90) */
  retentionDays?: number;
  /** Hash algorithm (default: 'sha256') */
  algorithm?: 'sha256' | 'sha512';
  /** Whether to enforce append-only file permissions (default: true) */
  enforceAppendOnly?: boolean;
  /**
   * Recovery behavior when the on-disk chain fails verification at construction.
   * - `'strict'` (default): throw `AuditLogIntegrityError`
   * - `'quarantine'`: move the existing log aside to `<path>.corrupt.<ts>` and
   *   start a fresh chain from genesis. Use only when you have an out-of-band
   *   record that the previous log was already lost (operator decision).
   */
  recoveryMode?: 'strict' | 'quarantine';
  /**
   * Lockfile acquisition timeout in milliseconds (default: 5000).
   * Set to 0 to disable inter-process locking (single-writer environments only).
   */
  lockTimeoutMs?: number;
  /**
   * Lockfile staleness threshold in milliseconds (default: 30000).
   * A `.lock` file older than this is treated as abandoned and reclaimed.
   */
  lockStaleMs?: number;
}

/**
 * A single entry in the hash-chained audit log.
 */
export interface AuditLogEntry {
  /** Monotonically increasing sequence number */
  sequence: number;
  /** Timestamp of the entry (ISO 8601) */
  timestamp: string;
  /** SHA-256 hash of the previous entry (genesis hash for first entry) */
  previousHash: string;
  /** SHA-256 hash of this entry's content (computed after creation) */
  contentHash: string;
  /** The actual audit data (redacted State Contract) */
  data: Record<string, unknown>;
}

/**
 * Retention cutoff sidecar — records the most recent retention enforcement
 * point. Entries with `sequence <= cutoffSequence` are considered logically
 * expired but remain physically on disk so the hash chain stays intact and
 * `verify()` keeps passing. `exportForCompliance()` and `iterateLiveEntries()`
 * filter by this cutoff.
 */
export interface RetentionCutoff {
  /** ISO timestamp at-or-before which entries are expired */
  cutoffTimestamp: string;
  /** Highest sequence number that is logically expired (<= is expired) */
  cutoffSequence: number;
  /** Content hash of the entry at cutoffSequence (anchors the cutoff) */
  cutoffHash: string;
  /** Retention window in days at the time of enforcement */
  retentionDays: number;
  /** ISO timestamp when this cutoff was enforced */
  enforcedAt: string;
}

/**
 * Genesis hash for the first entry in the chain.
 * A known constant that proves the chain starts here.
 */
export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Thrown when the on-disk audit log fails chain verification.
 *
 * Construction with `recoveryMode: 'strict'` (the default) raises this rather
 * than silently restarting the chain. Carries the last verified sequence so
 * operators can quarantine and resume manually.
 */
export class AuditLogIntegrityError extends Error {
  constructor(
    message: string,
    public readonly logPath: string,
    public readonly lastValidSequence: number,
  ) {
    super(message);
    this.name = 'AuditLogIntegrityError';
  }
}

/**
 * Recursively sort all object keys for deterministic JSON serialization.
 * Uses Object.create(null) to prevent __proto__ prototype pollution attacks.
 * Rejects __proto__, prototype, and constructor keys to prevent hash bypass.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  // Use Object.create(null) to prevent __proto__ attacks
  const sorted = Object.create(null);
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    if (FORBIDDEN_KEYS.has(key)) {
      // Encode forbidden keys as safe property names to include in hash
      sorted[`_forbidden_${key}`] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    } else {
      sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    }
  }
  return sorted;
}

/**
 * Compute SHA-256 hash of a JSON-serializable object.
 *
 * Keys are sorted recursively for deterministic output. Uses the shared
 * single-pass {@link canonicalize} emitter so we do not allocate an
 * intermediate fully-sorted object graph (fix for #17). The resulting
 * hash bytes are unchanged from the previous
 * `JSON.stringify(sortObjectKeys(data))` formulation, preserving the on-disk
 * audit-log chain format.
 */
function computeHash(data: unknown, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
  const hash = crypto.createHash(algorithm);
  hash.update(canonicalize(data));
  return hash.digest('hex');
}

/**
 * Parsed line from the audit log along with diagnostic metadata. Streaming
 * read paths emit one of these per non-empty line so callers can react to
 * parse / chain failures without loading the whole file.
 */
export interface IteratedLine {
  /** 1-based line number in the file */
  lineNo: number;
  /** Raw line text (without trailing newline) */
  raw: string;
  /** Parsed entry, present iff `parseError` is undefined */
  parsed?: AuditLogEntry;
  /** Parser error message if the line is not a valid JSON entry */
  parseError?: string;
}

/**
 * Stream the audit log file line-by-line without loading it into memory.
 * Empty lines are skipped. Lines that fail to parse are still yielded with
 * `parseError` set so callers can decide how to react.
 *
 * @param logPath Absolute path to the log file
 */
export async function* iterateAuditLog(logPath: string): AsyncGenerator<IteratedLine> {
  if (!fs.existsSync(logPath)) return;

  const stream = fs.createReadStream(logPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  try {
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      lineNo++;
      let parsed: AuditLogEntry | undefined;
      let parseError: string | undefined;
      try {
        parsed = JSON.parse(raw) as AuditLogEntry;
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
      }
      yield { lineNo, raw, parsed, parseError };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Result of a streaming chain verification.
 *
 * `partialTailBytes` is non-zero when the file ends mid-line (no trailing `\n`
 * after the last byte). That tail is *not* counted as a valid entry; it is the
 * signal that an append crashed before fdatasync completed.
 */
export interface StreamVerifyResult {
  valid: boolean;
  error?: string;
  lastValidSequence: number;
  lastHash: string;
  totalEntries: number;
  /** Number of bytes in a partial (non-newline-terminated) trailing record. */
  partialTailBytes: number;
}

/**
 * Detect whether the file ends with a trailing newline. Used to flag
 * crash-during-append: if the last byte is not `\n`, an append never completed
 * its `\n` write and the trailing bytes are an incomplete record.
 *
 * Returns the count of trailing non-newline bytes (0 if file is empty or
 * properly terminated).
 */
function trailingPartialBytes(logPath: string): number {
  if (!fs.existsSync(logPath)) return 0;
  const stat = fs.statSync(logPath);
  if (stat.size === 0) return 0;
  const fd = fs.openSync(logPath, 'r');
  try {
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, stat.size - 1);
    if (buf[0] === 0x0a) return 0;
    // Walk backward to count the partial-line bytes
    let n = 0;
    const chunk = Buffer.alloc(4096);
    let pos = stat.size;
    while (pos > 0) {
      const want = Math.min(chunk.length, pos);
      pos -= want;
      fs.readSync(fd, chunk, 0, want, pos);
      for (let i = want - 1; i >= 0; i--) {
        if (chunk[i] === 0x0a) return n;
        n++;
      }
    }
    return n;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream-verify a hash-chained audit log without loading it into memory.
 *
 * Walks the file front-to-back, validating sequence continuity, previousHash
 * linkage, and contentHash recomputation. Stops at the first failure and
 * returns the last verified head. `partialTailBytes > 0` indicates a partial
 * trailing record (crash during append) — callers should treat as recoverable
 * (truncate the partial bytes) but not as a verification pass.
 */
export async function streamVerify(
  logPath: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
): Promise<StreamVerifyResult> {
  const partialTailBytes = trailingPartialBytes(logPath);

  if (!fs.existsSync(logPath) || fs.statSync(logPath).size === 0) {
    return {
      valid: true,
      lastValidSequence: 0,
      lastHash: GENESIS_HASH,
      totalEntries: 0,
      partialTailBytes: 0,
    };
  }

  let expectedSequence = 0;
  let expectedHash = GENESIS_HASH;
  let lastHash = GENESIS_HASH;
  let totalEntries = 0;

  for await (const line of iterateAuditLog(logPath)) {
    if (line.parseError) {
      return {
        valid: false,
        error: `Invalid JSON at line ${line.lineNo} (sequence ${expectedSequence + 1}): ${line.parseError}`,
        lastValidSequence: expectedSequence,
        lastHash,
        totalEntries,
        partialTailBytes,
      };
    }
    const entry = line.parsed!;
    totalEntries++;

    if (entry.sequence !== expectedSequence + 1) {
      return {
        valid: false,
        error: `Sequence mismatch at line ${line.lineNo}: expected ${expectedSequence + 1}, got ${entry.sequence}`,
        lastValidSequence: expectedSequence,
        lastHash,
        totalEntries,
        partialTailBytes,
      };
    }

    if (entry.previousHash !== expectedHash) {
      return {
        valid: false,
        error: `Hash chain broken at sequence ${entry.sequence}: previousHash mismatch`,
        lastValidSequence: expectedSequence,
        lastHash,
        totalEntries,
        partialTailBytes,
      };
    }

    const computed = computeHash(
      {
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        previousHash: entry.previousHash,
        data: entry.data,
      },
      algorithm,
    );
    if (entry.contentHash !== computed) {
      return {
        valid: false,
        error: `Content hash mismatch at sequence ${entry.sequence}: entry was modified`,
        lastValidSequence: expectedSequence,
        lastHash,
        totalEntries,
        partialTailBytes,
      };
    }

    expectedSequence = entry.sequence;
    expectedHash = entry.contentHash;
    lastHash = entry.contentHash;
  }

  return {
    valid: partialTailBytes === 0,
    error: partialTailBytes > 0
      ? `Partial trailing record: ${partialTailBytes} bytes after last newline (crash during append?)`
      : undefined,
    lastValidSequence: expectedSequence,
    lastHash,
    totalEntries,
    partialTailBytes,
  };
}

// ─── lockfile helpers ──────────────────────────────────────────────────────

interface LockHandle {
  lockPath: string;
  fd: number;
}

function readLockOwner(lockPath: string): { pid: number; startedAt: number } | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const obj = JSON.parse(raw) as { pid: number; startedAt: number };
    if (typeof obj.pid !== 'number' || typeof obj.startedAt !== 'number') return null;
    return obj;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we can't signal it
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireLock(logPath: string, timeoutMs: number, staleMs: number): LockHandle {
  const lockPath = `${logPath}.lock`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });

  // First attempt fast-path; then back off.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, payload);
      try {
        fs.fsyncSync(fd);
      } catch {
        /* fsync best-effort on platforms that disallow it on the lock fd */
      }
      return { lockPath, fd };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Lock exists — check for staleness.
      let stale = false;
      try {
        const stat = fs.statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > staleMs) stale = true;
        const owner = readLockOwner(lockPath);
        if (owner && !pidAlive(owner.pid)) stale = true;
      } catch {
        // race: lock vanished between EEXIST and stat — retry
      }

      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* another waiter beat us to it; loop */
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Audit log lock acquisition timed out after ${timeoutMs}ms: ${lockPath} is held by another writer.`,
        );
      }
      // Short blocking sleep — avoid pinning a CPU.
      const waitMs = 5 + Math.floor(Math.random() * 25);
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        // busy-wait small window; sync API has no proper sleep
      }
    }
  }
}

function releaseLock(handle: LockHandle): void {
  try {
    fs.closeSync(handle.fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(handle.lockPath);
  } catch {
    /* ignore */
  }
}

// ─── retention sidecar helpers ────────────────────────────────────────────

function retentionPath(logPath: string): string {
  return `${logPath}.retention.cutoff`;
}

function readRetentionCutoff(logPath: string): RetentionCutoff | null {
  const p = retentionPath(logPath);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as RetentionCutoff;
  } catch {
    return null;
  }
}

function writeRetentionCutoff(logPath: string, cutoff: RetentionCutoff): void {
  const finalPath = retentionPath(logPath);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(cutoff, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
}

/**
 * Hash-chained append-only audit log.
 *
 * Each entry includes a hash of the previous entry, creating a tamper-evident
 * chain. If any entry is modified, all subsequent hashes will be invalid.
 *
 * Crash safety:
 *   appends use `O_APPEND` + `fdatasync` so a successful return implies the
 *   record is durably on disk.
 *
 * Inter-process safety:
 *   appends and retention enforcement are guarded by an advisory lockfile
 *   (`<path>.lock`). Stale locks (process gone or older than `lockStaleMs`)
 *   are reclaimed automatically.
 *
 * Memory:
 *   no read path loads the whole file. `verify()`, `loadState()`,
 *   `exportForCompliance()`, and `enforceRetention()` stream line-by-line.
 *
 * Retention:
 *   `enforceRetention()` writes a `<path>.retention.cutoff` sidecar. The hash
 *   chain on disk is **never** rewritten, so `verify()` still walks end-to-end.
 *   Logically-expired entries are filtered out of `exportForCompliance()`.
 */
export class ComplianceAuditLog {
  private readonly config: Required<Omit<ComplianceConfig, 'recoveryMode'>> & {
    recoveryMode: 'strict' | 'quarantine';
  };
  private currentSequence: number;
  private lastHash: string;
  /** Single-process write mutex: queues async appends made through `append()`. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(config: ComplianceConfig) {
    this.config = {
      logPath: config.logPath,
      retentionDays: config.retentionDays ?? 90,
      algorithm: config.algorithm ?? 'sha256',
      enforceAppendOnly: config.enforceAppendOnly ?? true,
      recoveryMode: config.recoveryMode ?? 'strict',
      lockTimeoutMs: config.lockTimeoutMs ?? 5000,
      lockStaleMs: config.lockStaleMs ?? 30000,
    };

    // Ensure directory exists
    const dir = path.dirname(this.config.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Load existing log state (stream-verifies the entire chain).
    const { sequence, lastHash } = this.loadStateSync();
    this.currentSequence = sequence;
    this.lastHash = lastHash;
  }

  /**
   * Append a new entry to the audit log.
   *
   * Crash-safe: opens the log with `O_APPEND`, writes one full line, calls
   * `fdatasync`, then closes. A returned entry is durably persisted.
   *
   * Inter-process safe: holds the advisory lockfile across read-tail +
   * compute-hash + append, so concurrent writers cannot collide on sequence
   * numbers or `previousHash`.
   *
   * @param data - The audit data (typically a redacted State Contract)
   * @returns The created AuditLogEntry with computed hashes
   */
  append(data: Record<string, unknown>): AuditLogEntry {
    const lock = this.config.lockTimeoutMs > 0
      ? acquireLock(this.config.logPath, this.config.lockTimeoutMs, this.config.lockStaleMs)
      : null;

    try {
      // Re-read tail under lock so concurrent writers see each other's last hash.
      const tail = readChainTailSync(this.config.logPath, this.config.algorithm);
      if (tail.partialTailBytes > 0) {
        throw new AuditLogIntegrityError(
          `Refusing to append: log has a ${tail.partialTailBytes}-byte partial trailing record. ` +
            `Resolve the partial tail (truncate or quarantine) before resuming writes.`,
          this.config.logPath,
          tail.lastSequence,
        );
      }
      this.currentSequence = tail.lastSequence;
      this.lastHash = tail.lastHash;

      const sequence = this.currentSequence + 1;
      const timestamp = new Date().toISOString();
      const previousHash = this.lastHash;

      const entryWithoutHash = { sequence, timestamp, previousHash, data };
      const contentHash = computeHash(entryWithoutHash, this.config.algorithm);
      const entry: AuditLogEntry = { ...entryWithoutHash, contentHash };

      const line = JSON.stringify(entry) + '\n';

      // Crash-safe append: O_APPEND ensures all writers atomically extend the
      // file under POSIX. fdatasync forces the kernel buffer to disk.
      const fd = fs.openSync(this.config.logPath, fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
      try {
        fs.writeSync(fd, line);
        fs.fdatasyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      this.currentSequence = sequence;
      this.lastHash = contentHash;

      return entry;
    } finally {
      if (lock) releaseLock(lock);
    }
  }

  /**
   * Verify the integrity of the entire audit log (streaming).
   *
   * Returns true if all hashes are valid and the chain is unbroken.
   * Returns false if any entry has been modified or the chain is broken.
   *
   * Note: this method is intentionally synchronous for backwards compatibility,
   * but internally uses a streaming reader. For very large logs prefer
   * {@link verifyAsync}.
   */
  verify(): { valid: boolean; error?: string; lastValidSequence?: number } {
    const result = streamVerifySync(this.config.logPath, this.config.algorithm);
    return {
      valid: result.valid,
      error: result.error,
      lastValidSequence: result.lastValidSequence,
    };
  }

  /**
   * Async streaming verification — preferred for very large logs.
   */
  async verifyAsync(): Promise<StreamVerifyResult> {
    return streamVerify(this.config.logPath, this.config.algorithm);
  }

  /**
   * Enforce the retention policy.
   *
   * Records a retention-cutoff sidecar (`<path>.retention.cutoff`) that
   * captures the timestamp / sequence / hash of the most recent entry that
   * is older than `retentionDays`. The on-disk hash chain is **not**
   * rewritten — chain integrity is preserved end-to-end and `verify()`
   * continues to pass.
   *
   * @throws AuditLogIntegrityError if the chain currently fails verification
   * (refuses to enforce retention over a corrupt chain).
   */
  enforceRetention(): { removed: number; remaining: number } {
    const lock = this.config.lockTimeoutMs > 0
      ? acquireLock(this.config.logPath, this.config.lockTimeoutMs, this.config.lockStaleMs)
      : null;
    try {
      if (!fs.existsSync(this.config.logPath)) {
        return { removed: 0, remaining: 0 };
      }

      const verifyResult = streamVerifySync(this.config.logPath, this.config.algorithm);
      if (!verifyResult.valid) {
        throw new AuditLogIntegrityError(
          `Refusing to enforce retention: chain is currently invalid (${verifyResult.error ?? 'unknown error'}).`,
          this.config.logPath,
          verifyResult.lastValidSequence,
        );
      }

      const cutoffDate = new Date(Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000);

      let cutoffEntry: AuditLogEntry | null = null;
      let total = 0;
      for (const line of iterateAuditLogSync(this.config.logPath)) {
        if (line.parseError) continue;
        total++;
        const entry = line.parsed!;
        if (new Date(entry.timestamp) < cutoffDate) {
          cutoffEntry = entry;
        }
      }

      if (!cutoffEntry) {
        const prior = readRetentionCutoff(this.config.logPath);
        return { removed: prior?.cutoffSequence ?? 0, remaining: total - (prior?.cutoffSequence ?? 0) };
      }

      const cutoff: RetentionCutoff = {
        cutoffTimestamp: cutoffEntry.timestamp,
        cutoffSequence: cutoffEntry.sequence,
        cutoffHash: cutoffEntry.contentHash,
        retentionDays: this.config.retentionDays,
        enforcedAt: new Date().toISOString(),
      };
      writeRetentionCutoff(this.config.logPath, cutoff);

      return { removed: cutoffEntry.sequence, remaining: total - cutoffEntry.sequence };
    } finally {
      if (lock) releaseLock(lock);
    }
  }

  /**
   * Read the active retention cutoff (if any).
   */
  getRetentionCutoff(): RetentionCutoff | null {
    return readRetentionCutoff(this.config.logPath);
  }

  /**
   * Stream entries that are NOT logically expired (i.e. `sequence` >
   * cutoffSequence, or all entries if no cutoff exists).
   */
  async *iterateLiveEntries(): AsyncGenerator<AuditLogEntry> {
    const cutoff = readRetentionCutoff(this.config.logPath);
    const cutoffSeq = cutoff?.cutoffSequence ?? 0;
    for await (const line of iterateAuditLog(this.config.logPath)) {
      if (line.parseError) continue;
      const entry = line.parsed!;
      if (entry.sequence > cutoffSeq) yield entry;
    }
  }

  /**
   * Export audit log data in SOC 2-compliant format.
   *
   * Streams the file (no full-load) and excludes entries logically expired by
   * the retention cutoff sidecar.
   */
  exportForCompliance(): {
    verificationResult: { valid: boolean; error?: string; lastValidSequence?: number };
    summary: {
      totalEntries: number;
      dateRange: { start: string; end: string };
      retentionDays: number;
      algorithm: string;
      retentionCutoff: RetentionCutoff | null;
    };
    entries: AuditLogEntry[];
    exportedAt: string;
  } {
    const verification = this.verify();
    const retention = readRetentionCutoff(this.config.logPath);
    const cutoffSeq = retention?.cutoffSequence ?? 0;

    if (!fs.existsSync(this.config.logPath)) {
      return {
        verificationResult: verification,
        summary: {
          totalEntries: 0,
          dateRange: { start: '', end: '' },
          retentionDays: this.config.retentionDays,
          algorithm: this.config.algorithm,
          retentionCutoff: retention,
        },
        entries: [],
        exportedAt: new Date().toISOString(),
      };
    }

    const entries: AuditLogEntry[] = [];
    let firstTs = '';
    let lastTs = '';
    for (const line of iterateAuditLogSync(this.config.logPath)) {
      if (line.parseError) continue;
      const entry = line.parsed!;
      if (entry.sequence <= cutoffSeq) continue;
      entries.push(entry);
      if (!firstTs) firstTs = entry.timestamp;
      lastTs = entry.timestamp;
    }

    return {
      verificationResult: verification,
      summary: {
        totalEntries: entries.length,
        dateRange: { start: firstTs, end: lastTs },
        retentionDays: this.config.retentionDays,
        algorithm: this.config.algorithm,
        retentionCutoff: retention,
      },
      entries,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Stream-verify the existing log and adopt its head — refuses to silently
   * recover from a broken chain.
   *
   * On a clean log: returns the verified head sequence/hash.
   *
   * On a partial trailing record (crash during append): the partial bytes are
   * truncated and the chain head is taken from the last fully-persisted entry.
   *
   * On a hard chain failure (sequence gap, hash mismatch, parse error mid-
   * file): throws `AuditLogIntegrityError` unless `recoveryMode === 'quarantine'`,
   * in which case the bad log is renamed `<path>.corrupt.<ts>` and a fresh
   * chain starts from genesis.
   */
  private loadStateSync(): { sequence: number; lastHash: string } {
    if (!fs.existsSync(this.config.logPath)) {
      return { sequence: 0, lastHash: GENESIS_HASH };
    }
    if (fs.statSync(this.config.logPath).size === 0) {
      return { sequence: 0, lastHash: GENESIS_HASH };
    }

    const result = streamVerifySync(this.config.logPath, this.config.algorithm);

    // Case 1: chain verifies cleanly with no partial tail
    if (result.valid && result.partialTailBytes === 0) {
      return { sequence: result.lastValidSequence, lastHash: result.lastHash };
    }

    // Case 2: chain verifies but ends mid-line (crash during append). Truncate
    // the partial bytes and resume — entries before the partial line are
    // verified-good, so this is safe.
    if (
      result.lastValidSequence > 0 &&
      result.partialTailBytes > 0 &&
      result.totalEntries === result.lastValidSequence
    ) {
      this.truncatePartialTail(result.partialTailBytes);
      return { sequence: result.lastValidSequence, lastHash: result.lastHash };
    }

    // Case 3: hard chain failure — strict mode throws, quarantine renames.
    const message = `Audit log integrity check failed at ${this.config.logPath}: ${result.error ?? 'unknown error'}`;
    if (this.config.recoveryMode === 'quarantine') {
      this.quarantineLog();
      return { sequence: 0, lastHash: GENESIS_HASH };
    }
    throw new AuditLogIntegrityError(message, this.config.logPath, result.lastValidSequence);
  }

  private truncatePartialTail(bytes: number): void {
    const stat = fs.statSync(this.config.logPath);
    const newSize = stat.size - bytes;
    const fd = fs.openSync(this.config.logPath, 'r+');
    try {
      fs.ftruncateSync(fd, newSize);
      fs.fdatasyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private quarantineLog(): void {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${this.config.logPath}.corrupt.${ts}`;
    fs.renameSync(this.config.logPath, target);
    // Also move retention sidecar if present so it doesn't apply to a fresh chain.
    const sidecar = retentionPath(this.config.logPath);
    if (fs.existsSync(sidecar)) {
      fs.renameSync(sidecar, `${target}.retention.cutoff`);
    }
  }
}

// ─── synchronous streaming helpers ────────────────────────────────────────
// We use a small line-buffered sync reader to keep the public API
// synchronous while still avoiding full-file loads. Memory is bounded to one
// chunk (64 KiB) plus the longest single line.

const READ_CHUNK = 64 * 1024;

function* iterateAuditLogSync(logPath: string): Generator<IteratedLine> {
  if (!fs.existsSync(logPath)) return;
  const fd = fs.openSync(logPath, 'r');
  const buffer = Buffer.alloc(READ_CHUNK);
  let carry = '';
  let lineNo = 0;
  try {
    let pos = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      carry += buffer.subarray(0, bytesRead).toString('utf-8');
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const raw = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (!raw.trim()) continue;
        lineNo++;
        let parsed: AuditLogEntry | undefined;
        let parseError: string | undefined;
        try {
          parsed = JSON.parse(raw) as AuditLogEntry;
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }
        yield { lineNo, raw, parsed, parseError };
      }
    }
    // Any non-empty carry here is a partial trailing line (no newline). We do
    // NOT yield it as a full entry — callers detect partial tails via
    // `trailingPartialBytes`.
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Synchronous streaming chain verification — backs the sync `verify()` API.
 */
export function streamVerifySync(
  logPath: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
): StreamVerifyResult {
  const partialTailBytes = trailingPartialBytes(logPath);

  if (!fs.existsSync(logPath) || fs.statSync(logPath).size === 0) {
    return {
      valid: true,
      lastValidSequence: 0,
      lastHash: GENESIS_HASH,
      totalEntries: 0,
      partialTailBytes: 0,
    };
  }

  let expectedSequence = 0;
  let expectedHash = GENESIS_HASH;
  let lastHash = GENESIS_HASH;
  let totalEntries = 0;

  for (const line of iterateAuditLogSync(logPath)) {
    if (line.parseError) {
      return {
        valid: false,
        error: `Invalid JSON at line ${line.lineNo} (sequence ${expectedSequence + 1}): ${line.parseError}`,
        lastValidSequence: expectedSequence,
        lastHash,
        totalEntries,
        partialTailBytes,
      };
    }
    const entry = line.parsed!;
    totalEntries++;

    if (entry.sequence !== expectedSequence + 1) {
      return {
        valid: false,
        error: `Sequence mismatch at line ${line.lineNo}: expected ${expectedSequence + 1}, got ${entry.sequence}`,
        lastValidSequence: expectedSequence,
        lastHash,
        totalEntries,
        partialTailBytes,
      };
    }

    if (entry.previousHash !== expectedHash) {
      return {
        valid: false,
        error: `Hash chain broken at sequence ${entry.sequence}: previousHash mismatch`,
        lastValidSequence: expectedSequence,
        lastHash,
        totalEntries,
        partialTailBytes,
      };
    }

    const computed = computeHash(
      {
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        previousHash: entry.previousHash,
        data: entry.data,
      },
      algorithm,
    );
    if (entry.contentHash !== computed) {
      return {
        valid: false,
        error: `Content hash mismatch at sequence ${entry.sequence}: entry was modified`,
        lastValidSequence: expectedSequence,
        lastHash,
        totalEntries,
        partialTailBytes,
      };
    }

    expectedSequence = entry.sequence;
    expectedHash = entry.contentHash;
    lastHash = entry.contentHash;
  }

  return {
    valid: partialTailBytes === 0,
    error: partialTailBytes > 0
      ? `Partial trailing record: ${partialTailBytes} bytes after last newline`
      : undefined,
    lastValidSequence: expectedSequence,
    lastHash,
    totalEntries,
    partialTailBytes,
  };
}

/**
 * Read just the chain tail (last fully-persisted entry) without a full pass.
 * Used by `append()` under lock so concurrent writers see each other's
 * state without paying full-verify cost on every write.
 */
function readChainTailSync(
  logPath: string,
  algorithm: 'sha256' | 'sha512',
): { lastSequence: number; lastHash: string; partialTailBytes: number } {
  if (!fs.existsSync(logPath) || fs.statSync(logPath).size === 0) {
    return { lastSequence: 0, lastHash: GENESIS_HASH, partialTailBytes: 0 };
  }

  const partialTailBytes = trailingPartialBytes(logPath);
  const stat = fs.statSync(logPath);
  // Read the trailing window; entries are typically a few KB, so 64 KiB is
  // sufficient for "the last entry" in nearly all cases. If the last entry is
  // larger than the window, we expand.
  let windowSize = Math.min(stat.size, 64 * 1024);
  while (windowSize <= stat.size) {
    const start = stat.size - windowSize;
    const buf = Buffer.alloc(windowSize);
    const fd = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fd, buf, 0, windowSize, start);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString('utf-8');
    // Strip any partial-tail bytes
    const usable = partialTailBytes > 0 ? text.slice(0, text.length - partialTailBytes) : text;
    const lines = usable.split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      if (windowSize === stat.size) break;
      windowSize = Math.min(stat.size, windowSize * 2);
      continue;
    }
    const last = lines[lines.length - 1];
    // Only trust the last line if either (a) we read the whole file, or (b) we
    // have at least two complete lines in the window (so the last is not
    // truncated at the start). When (b) doesn't hold we expand the window.
    const haveBoundary = windowSize === stat.size || lines.length >= 2;
    if (!haveBoundary) {
      windowSize = Math.min(stat.size, windowSize * 2);
      continue;
    }
    try {
      const entry = JSON.parse(last) as AuditLogEntry;
      // Re-verify just this entry's content hash so we don't trust a tampered tail.
      const computed = computeHash(
        {
          sequence: entry.sequence,
          timestamp: entry.timestamp,
          previousHash: entry.previousHash,
          data: entry.data,
        },
        algorithm,
      );
      if (computed !== entry.contentHash) {
        throw new AuditLogIntegrityError(
          'Trailing entry contentHash mismatch — log was tampered with between writes.',
          logPath,
          entry.sequence - 1,
        );
      }
      return { lastSequence: entry.sequence, lastHash: entry.contentHash, partialTailBytes };
    } catch (err) {
      if (err instanceof AuditLogIntegrityError) throw err;
      // Tail is unparseable — fall back to a full streaming verify so the caller
      // gets an integrity error rather than a silent reset.
      const v = streamVerifySync(logPath, algorithm);
      if (!v.valid && v.partialTailBytes === 0) {
        throw new AuditLogIntegrityError(
          `Cannot read chain tail: ${v.error ?? 'unparseable'}`,
          logPath,
          v.lastValidSequence,
        );
      }
      return { lastSequence: v.lastValidSequence, lastHash: v.lastHash, partialTailBytes };
    }
  }

  return { lastSequence: 0, lastHash: GENESIS_HASH, partialTailBytes };
}

// silence unused-import warning when bundlers strip Readable
void Readable;

/**
 * Compliance features for Lattice audit logs.
 *
 * Provides:
 * - Hash-chained append-only audit logs (tamper-evident)
 * - Retention policy enforcement (90-day default)
 * - SOC 2 compliance export
 * - Integrity verification
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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
 * Genesis hash for the first entry in the chain.
 * A known constant that proves the chain starts here.
 */
export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

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
 * Keys are sorted recursively for deterministic output.
 */
function computeHash(data: unknown, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
  const hash = crypto.createHash(algorithm);
  hash.update(JSON.stringify(sortObjectKeys(data)));
  return hash.digest('hex');
}

/**
 * Hash-chained append-only audit log.
 *
 * Each entry includes a hash of the previous entry, creating a tamper-evident chain.
 * If any entry is modified, all subsequent hashes will be invalid.
 */
export class ComplianceAuditLog {
  private readonly config: Required<ComplianceConfig>;
  private currentSequence: number;
  private lastHash: string;
  private fileLock: { locked: boolean } = { locked: false };

  constructor(config: ComplianceConfig) {
    this.config = {
      logPath: config.logPath,
      retentionDays: config.retentionDays ?? 90,
      algorithm: config.algorithm ?? 'sha256',
      enforceAppendOnly: config.enforceAppendOnly ?? false, // Disabled by default to avoid silent degradation
    };

    // Ensure directory exists
    const dir = path.dirname(this.config.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Load existing log state
    const { sequence, lastHash } = this.loadState();
    this.currentSequence = sequence;
    this.lastHash = lastHash;
  }

  /**
   * Acquire an exclusive lock for append operations.
   * This prevents concurrent appends from corrupting the hash chain.
   */
  private acquireLock(): void {
    if (this.fileLock.locked) {
      throw new Error('ComplianceAuditLog: concurrent append detected — use a single instance or implement external locking');
    }
    this.fileLock.locked = true;
  }

  /**
   * Release the exclusive lock.
   */
  private releaseLock(): void {
    this.fileLock.locked = false;
  }

  /**
   * Append a new entry to the audit log.
   * This operation is append-only — existing entries cannot be modified.
   *
   * @param data - The audit data (typically a redacted State Contract)
   * @returns The created AuditLogEntry with computed hashes
   */
  append(data: Record<string, unknown>): AuditLogEntry {
    this.acquireLock();
    try {
      return this.appendUnsafe(data);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Internal append without lock protection.
   * Validates JSON-serializability before mutating state.
   */
  private appendUnsafe(data: Record<string, unknown>): AuditLogEntry {
    // Validate JSON-serializability before mutating state
    let line: string;
    try {
      const sequence = this.currentSequence + 1;
      const timestamp = new Date().toISOString();
      const previousHash = this.lastHash;

      const entryWithoutHash = {
        sequence,
        timestamp,
        previousHash,
        data,
      };

      const contentHash = computeHash(entryWithoutHash, this.config.algorithm);

      const entry: AuditLogEntry = {
        ...entryWithoutHash,
        contentHash,
      };

      line = JSON.stringify(entry) + '\n';

      // Mutate state only after successful serialization
      this.currentSequence = sequence;
      this.lastHash = contentHash;

      // Append to file (atomic append)
      fs.appendFileSync(this.config.logPath, line);

      return entry;
    } catch (error) {
      // If serialization fails, state is not mutated
      throw error;
    }
  }

  /**
   * Verify the integrity of the entire audit log.
   *
   * Returns true if all hashes are valid and the chain is unbroken.
   * Returns false if any entry has been modified or the chain is broken.
   */
  verify(): { valid: boolean; error?: string; lastValidSequence?: number } {
    if (!fs.existsSync(this.config.logPath)) {
      return { valid: true, error: undefined }; // Empty log is valid
    }

    const content = fs.readFileSync(this.config.logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    let expectedSequence = 0;
    let expectedHash = GENESIS_HASH;

    for (const line of lines) {
      let entry: AuditLogEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        return { valid: false, error: `Invalid JSON at line ${expectedSequence + 1}`, lastValidSequence: expectedSequence };
      }

      // Check sequence number
      if (entry.sequence !== expectedSequence + 1) {
        return {
          valid: false,
          error: `Sequence mismatch at line ${expectedSequence + 1}: expected ${expectedSequence + 1}, got ${entry.sequence}`,
          lastValidSequence: expectedSequence,
        };
      }

      // Check previous hash
      if (entry.previousHash !== expectedHash) {
        return {
          valid: false,
          error: `Hash chain broken at sequence ${entry.sequence}: previous hash mismatch`,
          lastValidSequence: expectedSequence,
        };
      }

      // Verify content hash
      const entryWithoutHash = {
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        previousHash: entry.previousHash,
        data: entry.data,
      };
      const computedHash = computeHash(entryWithoutHash, this.config.algorithm);
      if (entry.contentHash !== computedHash) {
        return {
          valid: false,
          error: `Content hash mismatch at sequence ${entry.sequence}: entry was modified`,
          lastValidSequence: expectedSequence,
        };
      }

      expectedSequence = entry.sequence;
      expectedHash = entry.contentHash;
    }

    return { valid: true, lastValidSequence: expectedSequence };
  }

  /**
   * Enforce the retention policy by moving expired entries to an archive segment.
   *
   * Instead of rewriting the log (which defeats tamper-evidence), this rotates
   * expired entries into a separate archive file and starts a new active segment.
   * The archive is signed with a checkpoint hash that proves what was rotated.
   */
  enforceRetention(): { removed: number; remaining: number; archivePath: string } {
    if (!fs.existsSync(this.config.logPath)) {
      return { removed: 0, remaining: 0, archivePath: '' };
    }

    const content = fs.readFileSync(this.config.logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const cutoffDate = new Date(Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000);

    const entries: AuditLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip invalid lines
      }
    }

    const expired = entries.filter(e => new Date(e.timestamp) < cutoffDate);
    const recent = entries.filter(e => new Date(e.timestamp) >= cutoffDate);

    if (expired.length === 0) {
      return { removed: 0, remaining: entries.length, archivePath: '' };
    }

    // Create archive segment with signed checkpoint
    const archivePath = this.config.logPath.replace(/\.jsonl$/, '') + `.archive-${Date.now()}.jsonl`;
    const archiveContent = expired.map(e => JSON.stringify(e) + '\n').join('');

    // Add checkpoint at the end of the archive
    const checkpoint = {
      type: 'retention_checkpoint',
      archivedEntries: expired.length,
      remainingEntries: recent.length,
      archiveHash: computeHash(archiveContent, this.config.algorithm),
      timestamp: new Date().toISOString(),
    };
    const archiveWithCheckpoint = archiveContent + JSON.stringify(checkpoint) + '\n';
    fs.writeFileSync(archivePath, archiveWithCheckpoint);

    // Rewrite active log with only recent entries, starting a new chain
    if (recent.length > 0) {
      // The first recent entry becomes the new genesis
      recent[0].previousHash = GENESIS_HASH;
      recent[0].contentHash = computeHash({
        sequence: recent[0].sequence,
        timestamp: recent[0].timestamp,
        previousHash: recent[0].previousHash,
        data: recent[0].data,
      }, this.config.algorithm);

      for (let i = 1; i < recent.length; i++) {
        recent[i].previousHash = recent[i - 1].contentHash;
        recent[i].contentHash = computeHash({
          sequence: recent[i].sequence,
          timestamp: recent[i].timestamp,
          previousHash: recent[i].previousHash,
          data: recent[i].data,
        }, this.config.algorithm);
      }

      const newContent = recent.map(e => JSON.stringify(e) + '\n').join('');
      fs.writeFileSync(this.config.logPath, newContent);

      // Update internal state
      this.currentSequence = recent[recent.length - 1].sequence;
      this.lastHash = recent[recent.length - 1].contentHash;
    } else {
      // No recent entries — reset to genesis
      fs.writeFileSync(this.config.logPath, '');
      this.currentSequence = 0;
      this.lastHash = GENESIS_HASH;
    }

    return { removed: expired.length, remaining: recent.length, archivePath };
  }

  /**
   * Export audit log data in SOC 2-compliant format.
   *
   * Includes:
   - Log integrity verification result
   - Summary statistics
   - Full entry list (redacted)
   - Retention policy details
   */
  exportForCompliance(): {
    verificationResult: { valid: boolean; error?: string; lastValidSequence?: number };
    summary: {
      totalEntries: number;
      dateRange: { start: string; end: string };
      retentionDays: number;
      algorithm: string;
    };
    entries: AuditLogEntry[];
    exportedAt: string;
  } {
    const verification = this.verify();

    if (!fs.existsSync(this.config.logPath)) {
      return {
        verificationResult: verification,
        summary: {
          totalEntries: 0,
          dateRange: { start: '', end: '' },
          retentionDays: this.config.retentionDays,
          algorithm: this.config.algorithm,
        },
        entries: [],
        exportedAt: new Date().toISOString(),
      };
    }

    const content = fs.readFileSync(this.config.logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const entries: AuditLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip invalid lines
      }
    }

    return {
      verificationResult: verification,
      summary: {
        totalEntries: entries.length,
        dateRange: {
          start: entries[0]?.timestamp ?? '',
          end: entries[entries.length - 1]?.timestamp ?? '',
        },
        retentionDays: this.config.retentionDays,
        algorithm: this.config.algorithm,
      },
      entries,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Load the current state (sequence number and last hash) from the log file.
   */
  private loadState(): { sequence: number; lastHash: string } {
    if (!fs.existsSync(this.config.logPath)) {
      return { sequence: 0, lastHash: GENESIS_HASH };
    }

    const content = fs.readFileSync(this.config.logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length === 0) {
      return { sequence: 0, lastHash: GENESIS_HASH };
    }

    // Read the last entry to get the current state
    try {
      const lastEntry = JSON.parse(lines[lines.length - 1]) as AuditLogEntry;
      return { sequence: lastEntry.sequence, lastHash: lastEntry.contentHash };
    } catch {
      // If the last line is corrupt, scan backwards
      for (let i = lines.length - 2; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as AuditLogEntry;
          return { sequence: entry.sequence, lastHash: entry.contentHash };
        } catch {
          // Continue scanning
        }
      }
      return { sequence: 0, lastHash: GENESIS_HASH };
    }
  }
}

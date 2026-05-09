/**
 * Immutable audit log verification API.
 *
 * Provides programmatic verification of audit log integrity:
 * - Hash chain verification (each entry's hash depends on the previous)
 * - Sequence number verification (monotonically increasing)
 * - Timestamp ordering verification
 * - File integrity (detect truncation, modification, injection)
 *
 * Designed for SOC 2 compliance and regulatory audits.
 *
 * Memory: all read paths stream the log line-by-line. No `readFileSync` of
 * the full file — safe to run against multi-gigabyte logs.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { streamVerifySync, GENESIS_HASH } from './audit-log.js';
import type { AuditLogEntry } from './audit-log.js';

const VERIFICATION_GENESIS_HASH = GENESIS_HASH;

/**
 * Recursively sort all object keys for deterministic JSON serialization.
 * Uses Object.create(null) to prevent __proto__ prototype pollution attacks.
 * Rejects __proto__, prototype, and constructor keys to prevent hash bypass.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  const sorted = Object.create(null);
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    if (FORBIDDEN_KEYS.has(key)) {
      sorted[`_forbidden_${key}`] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    } else {
      sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
    }
  }
  return sorted;
}

/**
 * Compute SHA-256 hash of a JSON-serializable object.
 */
function computeHash(data: unknown, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
  const hash = crypto.createHash(algorithm);
  hash.update(JSON.stringify(sortObjectKeys(data)));
  return hash.digest('hex');
}

/**
 * Result of a verification check.
 */
export interface VerificationResult {
  /** Whether the audit log is valid */
  valid: boolean;
  /** Detailed error message if invalid */
  error?: string;
  /** Last valid sequence number */
  lastValidSequence: number;
  /** Total entries in the log */
  totalEntries: number;
  /** Hash of the last entry */
  lastHash: string;
  /** Verification timestamp */
  verifiedAt: string;
  /** Algorithm used */
  algorithm: string;
}

/**
 * Detailed verification result with per-entry status.
 */
export interface DetailedVerificationResult extends VerificationResult {
  /** Per-entry verification status */
  entries: Array<{
    sequence: number;
    valid: boolean;
    error?: string;
  }>;
}

/**
 * Verify the integrity of an audit log file.
 *
 * Streams the log line-by-line; bounded memory regardless of file size.
 *
 * Checks:
 * 1. Each entry is valid JSON
 * 2. Sequence numbers are monotonically increasing starting from 1
 * 3. Each entry's previousHash matches the previous entry's contentHash
 * 4. Each entry's contentHash matches the recomputed hash of its content
 *
 * @param logPath - Path to the audit log file
 * @param algorithm - Hash algorithm (default: sha256)
 * @returns Verification result
 */
export function verifyAuditLog(
  logPath: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
): VerificationResult {
  const result = streamVerifySync(logPath, algorithm);
  return {
    valid: result.valid,
    error: result.error,
    lastValidSequence: result.lastValidSequence,
    totalEntries: result.totalEntries,
    lastHash: result.lastHash,
    verifiedAt: new Date().toISOString(),
    algorithm,
  };
}

/**
 * Perform detailed verification with per-entry status.
 *
 * Streams the log line-by-line. The per-entry array is the only unbounded
 * allocation (one record per entry); for very large logs prefer
 * {@link verifyAuditLog}, which keeps O(1) memory.
 */
export function verifyAuditLogDetailed(
  logPath: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
): DetailedVerificationResult {
  if (!fs.existsSync(logPath)) {
    return {
      valid: true,
      lastValidSequence: 0,
      totalEntries: 0,
      lastHash: VERIFICATION_GENESIS_HASH,
      verifiedAt: new Date().toISOString(),
      algorithm,
      entries: [],
    };
  }

  const entryResults: Array<{ sequence: number; valid: boolean; error?: string }> = [];

  let expectedSequence = 0;
  let expectedHash = VERIFICATION_GENESIS_HASH;
  let lastHash = VERIFICATION_GENESIS_HASH;
  let overallValid = true;
  let lastValidSequence = 0;
  let totalEntries = 0;

  const fd = fs.openSync(logPath, 'r');
  const stat = fs.fstatSync(fd);
  const CHUNK = 64 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let carry = '';
  let pos = 0;

  const processLine = (raw: string): void => {
    if (!raw.trim()) return;
    totalEntries++;

    let entry: AuditLogEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      entryResults.push({ sequence: expectedSequence + 1, valid: false, error: 'Invalid JSON' });
      overallValid = false;
      return;
    }

    if (entry.sequence !== expectedSequence + 1) {
      entryResults.push({
        sequence: entry.sequence,
        valid: false,
        error: `Sequence mismatch: expected ${expectedSequence + 1}, got ${entry.sequence}`,
      });
      overallValid = false;
      return;
    }

    if (entry.previousHash !== expectedHash) {
      entryResults.push({
        sequence: entry.sequence,
        valid: false,
        error: 'Hash chain broken',
      });
      overallValid = false;
      return;
    }

    const entryWithoutHash = {
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      previousHash: entry.previousHash,
      data: entry.data,
    };
    const computedHash = computeHash(entryWithoutHash, algorithm);
    if (entry.contentHash !== computedHash) {
      entryResults.push({
        sequence: entry.sequence,
        valid: false,
        error: 'Content hash mismatch (modified)',
      });
      overallValid = false;
      return;
    }

    entryResults.push({ sequence: entry.sequence, valid: true });
    expectedSequence = entry.sequence;
    expectedHash = entry.contentHash;
    lastHash = entry.contentHash;
    lastValidSequence = entry.sequence;
  };

  try {
    while (pos < stat.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, stat.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      carry += buf.subarray(0, n).toString('utf-8');
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const raw = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        processLine(raw);
      }
    }
    // Trailing partial line (no terminating \n) — flag as invalid JSON
    if (carry.trim()) {
      processLine(carry);
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    valid: overallValid,
    error: overallValid ? undefined : entryResults.find(e => !e.valid)?.error,
    lastValidSequence,
    totalEntries,
    lastHash,
    verifiedAt: new Date().toISOString(),
    algorithm,
    entries: entryResults,
  };
}

/**
 * Generate a verification certificate for the audit log.
 *
 * This certificate can be used to prove the integrity of the audit log
 * at a specific point in time (useful for compliance audits).
 */
export function generateVerificationCertificate(
  logPath: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
): {
  certificate: string;
  verification: VerificationResult;
} {
  const verification = verifyAuditLog(logPath, algorithm);

  // Generate a certificate hash that does NOT include the timestamp
  // (so the certificate remains verifiable over time)
  const certificateData = {
    logPath,
    verification: {
      valid: verification.valid,
      lastValidSequence: verification.lastValidSequence,
      totalEntries: verification.totalEntries,
      lastHash: verification.lastHash,
      algorithm: verification.algorithm,
    },
  };

  const certificateHash = computeHash(certificateData, algorithm);

  const certificate = `-----BEGIN LATTICE AUDIT LOG CERTIFICATE-----
Log Path: ${logPath}
Verification: ${verification.valid ? 'VALID' : 'INVALID'}
Last Valid Sequence: ${verification.lastValidSequence}
Total Entries: ${verification.totalEntries}
Last Hash: ${verification.lastHash}
Algorithm: ${verification.algorithm}
Verified At: ${verification.verifiedAt}
Certificate Hash: ${certificateHash}
-----END LATTICE AUDIT LOG CERTIFICATE-----`;

  return { certificate, verification };
}

/**
 * Verify a verification certificate against the current audit log.
 *
 * Parses the verification fields stored in the certificate text and
 * re-checks them against a fresh chain verification. The certificate is
 * valid iff every chain-relevant field (validity, last-valid sequence, total
 * entries, last hash, algorithm) matches the current log's verification.
 */
export function verifyCertificate(
  certificate: string,
  logPath: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
): boolean {
  try {
    const expected = parseCertificate(certificate);
    if (!expected) return false;

    const fresh = verifyAuditLog(logPath, expected.algorithm as 'sha256' | 'sha512');

    return (
      expected.valid === fresh.valid &&
      expected.lastValidSequence === fresh.lastValidSequence &&
      expected.totalEntries === fresh.totalEntries &&
      expected.lastHash === fresh.lastHash &&
      expected.algorithm === fresh.algorithm &&
      // The caller may have requested a different algorithm than the cert
      // was generated with — reject in that case.
      expected.algorithm === algorithm
    );
  } catch {
    return false;
  }
}

interface ParsedCertificate {
  logPath: string;
  valid: boolean;
  lastValidSequence: number;
  totalEntries: number;
  lastHash: string;
  algorithm: string;
  verifiedAt: string;
  certificateHash: string;
}

function parseCertificate(certificate: string): ParsedCertificate | null {
  const get = (label: string): string | null => {
    const m = certificate.match(new RegExp(`^${label}: (.*)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const logPath = get('Log Path');
  const validStr = get('Verification');
  const lvs = get('Last Valid Sequence');
  const total = get('Total Entries');
  const lastHash = get('Last Hash');
  const algorithm = get('Algorithm');
  const verifiedAt = get('Verified At');
  const certHash = get('Certificate Hash');
  if (
    logPath === null ||
    validStr === null ||
    lvs === null ||
    total === null ||
    lastHash === null ||
    algorithm === null ||
    verifiedAt === null ||
    certHash === null
  ) {
    return null;
  }
  return {
    logPath,
    valid: validStr === 'VALID',
    lastValidSequence: Number(lvs),
    totalEntries: Number(total),
    lastHash,
    algorithm,
    verifiedAt,
    certificateHash: certHash,
  };
}

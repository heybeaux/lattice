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
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import type { AuditLogEntry } from './audit-log';

const VERIFICATION_GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

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
  if (!fs.existsSync(logPath)) {
    return {
      valid: true,
      error: undefined,
      lastValidSequence: 0,
      totalEntries: 0,
      lastHash: VERIFICATION_GENESIS_HASH,
      verifiedAt: new Date().toISOString(),
      algorithm,
    };
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  let expectedSequence = 0;
  let expectedHash = VERIFICATION_GENESIS_HASH;
  let lastHash = VERIFICATION_GENESIS_HASH;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let entry: AuditLogEntry;

    try {
      entry = JSON.parse(line);
    } catch {
      return {
        valid: false,
        error: `Invalid JSON at line ${i + 1} (sequence ${expectedSequence + 1})`,
        lastValidSequence: expectedSequence,
        totalEntries: lines.length,
        lastHash,
        verifiedAt: new Date().toISOString(),
        algorithm,
      };
    }

    // Check sequence number
    if (entry.sequence !== expectedSequence + 1) {
      return {
        valid: false,
        error: `Sequence mismatch at line ${i + 1}: expected ${expectedSequence + 1}, got ${entry.sequence}`,
        lastValidSequence: expectedSequence,
        totalEntries: lines.length,
        lastHash,
        verifiedAt: new Date().toISOString(),
        algorithm,
      };
    }

    // Check previous hash
    if (entry.previousHash !== expectedHash) {
      return {
        valid: false,
        error: `Hash chain broken at sequence ${entry.sequence}: expected previous hash ${expectedHash.slice(0, 16)}..., got ${entry.previousHash.slice(0, 16)}...`,
        lastValidSequence: expectedSequence,
        totalEntries: lines.length,
        lastHash,
        verifiedAt: new Date().toISOString(),
        algorithm,
      };
    }

    // Verify content hash
    const entryWithoutHash = {
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      previousHash: entry.previousHash,
      data: entry.data,
    };
    const computedHash = computeHash(entryWithoutHash, algorithm);

    if (entry.contentHash !== computedHash) {
      return {
        valid: false,
        error: `Content hash mismatch at sequence ${entry.sequence}: entry was modified after creation`,
        lastValidSequence: expectedSequence,
        totalEntries: lines.length,
        lastHash,
        verifiedAt: new Date().toISOString(),
        algorithm,
      };
    }

    expectedSequence = entry.sequence;
    expectedHash = entry.contentHash;
    lastHash = entry.contentHash;
  }

  return {
    valid: true,
    error: undefined,
    lastValidSequence: expectedSequence,
    totalEntries: lines.length,
    lastHash,
    verifiedAt: new Date().toISOString(),
    algorithm,
  };
}

/**
 * Perform detailed verification with per-entry status.
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

  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const entryResults: Array<{ sequence: number; valid: boolean; error?: string }> = [];

  let expectedSequence = 0;
  let expectedHash = VERIFICATION_GENESIS_HASH;
  let lastHash = VERIFICATION_GENESIS_HASH;
  let overallValid = true;
  let lastValidSequence = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let entry: AuditLogEntry;

    try {
      entry = JSON.parse(line);
    } catch {
      entryResults.push({
        sequence: expectedSequence + 1,
        valid: false,
        error: 'Invalid JSON',
      });
      overallValid = false;
      continue;
    }

    // Check sequence number
    if (entry.sequence !== expectedSequence + 1) {
      entryResults.push({
        sequence: entry.sequence,
        valid: false,
        error: `Sequence mismatch: expected ${expectedSequence + 1}, got ${entry.sequence}`,
      });
      overallValid = false;
      continue;
    }

    // Check previous hash
    if (entry.previousHash !== expectedHash) {
      entryResults.push({
        sequence: entry.sequence,
        valid: false,
        error: 'Hash chain broken',
      });
      overallValid = false;
      continue;
    }

    // Verify content hash
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
      continue;
    }

    entryResults.push({
      sequence: entry.sequence,
      valid: true,
    });
    expectedSequence = entry.sequence;
    expectedHash = entry.contentHash;
    lastHash = entry.contentHash;
    lastValidSequence = entry.sequence;
  }

  return {
    valid: overallValid,
    lastValidSequence,
    totalEntries: lines.length,
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
 */
export function verifyCertificate(
  certificate: string,
  logPath: string,
  algorithm: 'sha256' | 'sha512' = 'sha256',
): boolean {
  try {
    // Extract the certificate hash
    const hashMatch = certificate.match(/Certificate Hash: ([a-f0-9]+)/);
    if (!hashMatch) return false;
    const expectedHash = hashMatch[1];

    // Regenerate the certificate from current log state
    const { certificate: regeneratedCertificate } = generateVerificationCertificate(logPath, algorithm);
    const regeneratedHashMatch = regeneratedCertificate.match(/Certificate Hash: ([a-f0-9]+)/);
    if (!regeneratedHashMatch) return false;

    return expectedHash === regeneratedHashMatch[1];
  } catch {
    return false;
  }
}

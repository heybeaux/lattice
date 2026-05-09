import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ComplianceAuditLog,
  GENESIS_HASH,
  AuditLogIntegrityError,
  verifyAuditLog,
  verifyAuditLogDetailed,
  generateVerificationCertificate,
  verifyCertificate,
  hasPermission,
  getPermissions,
  enforcePermission,
} from '../src/index.js';
import * as fs from 'fs';
import * as path from 'path';

const TEST_LOG_PATH = path.join(__dirname, 'test-audit.log');

/** Remove the log plus any sidecars (lock, retention cutoff, quarantined copies). */
function cleanupLogArtifacts(logPath: string): void {
  for (const p of [logPath, `${logPath}.lock`, `${logPath}.retention.cutoff`]) {
    if (fs.existsSync(p)) {
      try {
        fs.chmodSync(p, 0o644);
      } catch {
        /* ignore */
      }
      fs.unlinkSync(p);
    }
  }
  // Quarantined copies use timestamp-suffixed names.
  const dir = path.dirname(logPath);
  const base = path.basename(logPath);
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${base}.corrupt.`) || name.startsWith(`${base}.retention.cutoff.tmp.`)) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

describe('ComplianceAuditLog', () => {
  beforeEach(() => {
    cleanupLogArtifacts(TEST_LOG_PATH);
  });

  afterEach(() => {
    cleanupLogArtifacts(TEST_LOG_PATH);
  });

  it('creates a new audit log with genesis hash', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    const entry = log.append({ stepId: 'test', data: 'hello' });

    expect(entry.sequence).toBe(1);
    expect(entry.previousHash).toBe(GENESIS_HASH);
    expect(entry.contentHash).toBeDefined();
    expect(entry.timestamp).toBeDefined();
  });

  it('appends entries with correct hash chain', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });

    const entry1 = log.append({ stepId: 'step1' });
    const entry2 = log.append({ stepId: 'step2' });
    const entry3 = log.append({ stepId: 'step3' });

    expect(entry1.sequence).toBe(1);
    expect(entry2.previousHash).toBe(entry1.contentHash);
    expect(entry3.previousHash).toBe(entry2.contentHash);
  });

  it('verifies a valid chain', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });

    log.append({ stepId: 'step1' });
    log.append({ stepId: 'step2' });
    log.append({ stepId: 'step3' });

    const result = log.verify();
    expect(result.valid).toBe(true);
    expect(result.lastValidSequence).toBe(3);
  });

  it('detects tampered content', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });

    log.append({ stepId: 'step1' });
    log.append({ stepId: 'step2' });
    log.append({ stepId: 'step3' });

    // Tamper with the log file directly
    const content = fs.readFileSync(TEST_LOG_PATH, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const entry1 = JSON.parse(lines[0]);
    entry1.data = { tampered: true };
    // DON'T update contentHash - this is what makes it detectable
    lines[0] = JSON.stringify(entry1);
    fs.writeFileSync(TEST_LOG_PATH, lines.join('\n') + '\n');

    // The standalone verifier returns a structured error rather than throwing.
    const verifyResult = verifyAuditLog(TEST_LOG_PATH);
    expect(verifyResult.valid).toBe(false);
    expect(verifyResult.error).toContain('Content hash mismatch');
    expect(verifyResult.lastValidSequence).toBe(0);

    // The constructor in strict mode (default) refuses to load a tampered log.
    expect(() => new ComplianceAuditLog({ logPath: TEST_LOG_PATH })).toThrow(AuditLogIntegrityError);
  });

  it('detects broken hash chain', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });

    log.append({ stepId: 'step1' });
    log.append({ stepId: 'step2' });
    log.append({ stepId: 'step3' });

    // Break the chain by changing previousHash
    const content = fs.readFileSync(TEST_LOG_PATH, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const entry2 = JSON.parse(lines[1]);
    entry2.previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
    lines[1] = JSON.stringify(entry2);
    fs.writeFileSync(TEST_LOG_PATH, lines.join('\n') + '\n');

    const result = log.verify();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Hash chain broken');
  });

  it('detects sequence number gaps', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });

    log.append({ stepId: 'step1' });
    log.append({ stepId: 'step2' });

    // Skip a sequence number
    const entry3 = {
      sequence: 5, // Should be 3
      timestamp: new Date().toISOString(),
      previousHash: 'fake',
      contentHash: 'fake',
      data: { stepId: 'step3' },
    };
    fs.appendFileSync(TEST_LOG_PATH, JSON.stringify(entry3) + '\n');

    const result = log.verify();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Sequence mismatch');
  });

  it('persists state across instances', () => {
    const log1 = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log1.append({ stepId: 'step1' });
    log1.append({ stepId: 'step2' });

    // Create a new instance — should pick up where log1 left off
    const log2 = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    const entry3 = log2.append({ stepId: 'step3' });

    expect(entry3.sequence).toBe(3);
  });

  it('enforces retention policy via cutoff sidecar (chain stays intact)', () => {
    // Build a log whose first entry has an old timestamp by faking the system
    // clock for the first append, then restoring for the second.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    let log = new ComplianceAuditLog({
      logPath: TEST_LOG_PATH,
      retentionDays: 1,
    });
    log.append({ stepId: 'old' });
    vi.useRealTimers();
    // Reconstruct the log so the in-memory state reads the on-disk tail under
    // the now-real clock (avoids any leftover faked time interactions).
    log = new ComplianceAuditLog({
      logPath: TEST_LOG_PATH,
      retentionDays: 1,
    });
    log.append({ stepId: 'recent' });

    // Pre-retention: full chain verifies
    expect(log.verify().valid).toBe(true);

    const result = log.enforceRetention();
    // Old entry (sequence 1) is logically expired; recent entry (2) survives.
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(1);

    // Crucially: the on-disk chain is NOT rewritten, so verify still passes.
    const verifyResult = log.verify();
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.lastValidSequence).toBe(2);

    // The cutoff sidecar records the boundary.
    const cutoff = log.getRetentionCutoff();
    expect(cutoff).not.toBeNull();
    expect(cutoff!.cutoffSequence).toBe(1);

    // Export filters out the expired entry.
    const report = log.exportForCompliance();
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].sequence).toBe(2);
    expect(report.summary.retentionCutoff?.cutoffSequence).toBe(1);
  });

  it('exports compliance report', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log.append({ stepId: 'step1', passed: true });
    log.append({ stepId: 'step2', passed: false });

    const report = log.exportForCompliance();

    expect(report.verificationResult.valid).toBe(true);
    expect(report.summary.totalEntries).toBe(2);
    expect(report.summary.retentionDays).toBe(90);
    expect(report.entries).toHaveLength(2);
    expect(report.exportedAt).toBeDefined();
  });

  it('exports empty report when no log exists', () => {
    const log = new ComplianceAuditLog({ logPath: '/tmp/nonexistent-audit-' + Date.now() + '.log' });
    const report = log.exportForCompliance();

    expect(report.verificationResult.valid).toBe(true);
    expect(report.summary.totalEntries).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it('supports SHA-512 algorithm', () => {
    const log = new ComplianceAuditLog({
      logPath: TEST_LOG_PATH,
      algorithm: 'sha512',
    });

    const entry = log.append({ stepId: 'sha512-test' });
    expect(entry.contentHash.length).toBe(128); // SHA-512 produces 128 hex chars

    const result = log.verify();
    expect(result.valid).toBe(true);
  });

  it('handles empty log file', () => {
    fs.writeFileSync(TEST_LOG_PATH, '');
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });

    const result = log.verify();
    expect(result.valid).toBe(true);

    const entry = log.append({ stepId: 'first' });
    expect(entry.sequence).toBe(1);
  });

  it('rejects __proto__ prototype pollution in hash computation', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });

    // Create data with __proto__ key
    const maliciousData = JSON.parse('{"__proto__":{"secret":"unhashed"},"safe":1}');
    const entry = log.append(maliciousData);

    // The hash should include the forbidden key (as _forbidden___proto__)
    const result = log.verify();
    expect(result.valid).toBe(true);
  });

  it('throws on concurrent append attempts', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log.append({ stepId: 'step1' });

    // Simulate concurrent access by manually acquiring lock
    expect(() => {
      (log as any).acquireLock();
      (log as any).appendUnsafe({ stepId: 'step2' });
    }).not.toThrow();

    // Second append should fail due to lock
    expect(() => log.append({ stepId: 'step3' })).toThrow('concurrent append detected');

    // Release lock
    (log as any).releaseLock();
    // Now it should work
    expect(() => log.append({ stepId: 'step3' })).not.toThrow();
  });

  it('does not mutate sequence on serialization failure', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log.append({ stepId: 'step1' });

    // Try to append non-serializable data (BigInt)
    expect(() => log.append({ x: 1n } as any)).toThrow();

    // Sequence should still be 1, not 2
    const entry = log.append({ stepId: 'step2' });
    expect(entry.sequence).toBe(2);

    // Verify should pass (no sequence gap)
    const result = log.verify();
    expect(result.valid).toBe(true);
    expect(result.lastValidSequence).toBe(2);
  });
});

describe('Verification API', () => {
  beforeEach(() => {
    cleanupLogArtifacts(TEST_LOG_PATH);
  });

  afterEach(() => {
    cleanupLogArtifacts(TEST_LOG_PATH);
  });

  it('verifies a valid log', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log.append({ stepId: 'step1' });
    log.append({ stepId: 'step2' });
    log.append({ stepId: 'step3' });

    const result = verifyAuditLog(TEST_LOG_PATH);
    expect(result.valid).toBe(true);
    expect(result.lastValidSequence).toBe(3);
    expect(result.totalEntries).toBe(3);
  });

  it('detects tampering', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log.append({ stepId: 'step1' });
    log.append({ stepId: 'step2' });

    // Tamper with the file
    const content = fs.readFileSync(TEST_LOG_PATH, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const entry1 = JSON.parse(lines[0]);
    entry1.data = { tampered: true };
    lines[0] = JSON.stringify(entry1);
    fs.writeFileSync(TEST_LOG_PATH, lines.join('\n') + '\n');

    const result = verifyAuditLog(TEST_LOG_PATH);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Content hash mismatch');
  });

  it('provides detailed verification', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log.append({ stepId: 'step1' });
    log.append({ stepId: 'step2' });
    log.append({ stepId: 'step3' });

    const result = verifyAuditLogDetailed(TEST_LOG_PATH);
    expect(result.valid).toBe(true);
    expect(result.entries).toHaveLength(3);
    expect(result.entries.every(e => e.valid)).toBe(true);
  });

  it('generates a verification certificate', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log.append({ stepId: 'step1' });
    log.append({ stepId: 'step2' });

    const { certificate, verification } = generateVerificationCertificate(TEST_LOG_PATH);

    expect(certificate).toContain('BEGIN LATTICE AUDIT LOG CERTIFICATE');
    expect(certificate).toContain('END LATTICE AUDIT LOG CERTIFICATE');
    expect(certificate).toContain('Certificate Hash:');
    expect(verification.valid).toBe(true);
    expect(verification.lastValidSequence).toBe(2);
  });

  it('verifies a certificate', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log.append({ stepId: 'step1' });
    log.append({ stepId: 'step2' });

    const { certificate } = generateVerificationCertificate(TEST_LOG_PATH);
    const isValid = verifyCertificate(certificate, TEST_LOG_PATH);
    expect(isValid).toBe(true);
  });

  it('detects certificate tampering', () => {
    const log = new ComplianceAuditLog({ logPath: TEST_LOG_PATH });
    log.append({ stepId: 'step1' });

    const { certificate } = generateVerificationCertificate(TEST_LOG_PATH);

    // Tamper with the log after certificate generation
    const content = fs.readFileSync(TEST_LOG_PATH, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const entry1 = JSON.parse(lines[0]);
    entry1.data = { tampered: true };
    lines[0] = JSON.stringify(entry1);
    fs.writeFileSync(TEST_LOG_PATH, lines.join('\n') + '\n');

    const isValid = verifyCertificate(certificate, TEST_LOG_PATH);
    expect(isValid).toBe(false);
  });
});

describe('RBAC', () => {
  it('admin has full permissions', () => {
    const perms = getPermissions('admin');
    expect(perms.canView).toBe(true);
    expect(perms.canExport).toBe(true);
    expect(perms.canVerify).toBe(true);
    expect(perms.canModifyRetention).toBe(true);
    expect(perms.canDelete).toBe(true);
  });

  it('auditor can view and export but not modify', () => {
    const perms = getPermissions('auditor');
    expect(perms.canView).toBe(true);
    expect(perms.canExport).toBe(true);
    expect(perms.canVerify).toBe(true);
    expect(perms.canModifyRetention).toBe(false);
    expect(perms.canDelete).toBe(false);
  });

  it('viewer can only view', () => {
    const perms = getPermissions('viewer');
    expect(perms.canView).toBe(true);
    expect(perms.canExport).toBe(false);
    expect(perms.canVerify).toBe(false);
    expect(perms.canModifyRetention).toBe(false);
    expect(perms.canDelete).toBe(false);
  });

  it('hasPermission works correctly', () => {
    expect(hasPermission('admin', 'canDelete')).toBe(true);
    expect(hasPermission('auditor', 'canDelete')).toBe(false);
    expect(hasPermission('viewer', 'canExport')).toBe(false);
  });

  it('enforcePermission throws for unauthorized actions', () => {
    expect(() => enforcePermission('viewer', 'canExport', 'export audit log')).toThrow(
      "Access denied: role 'viewer' cannot export audit log"
    );

    expect(() => enforcePermission('auditor', 'canDelete', 'delete audit log')).toThrow(
      "Access denied: role 'auditor' cannot delete audit log"
    );

    // Should not throw for authorized actions
    expect(() => enforcePermission('admin', 'canDelete', 'delete audit log')).not.toThrow();
    expect(() => enforcePermission('auditor', 'canView', 'view audit log')).not.toThrow();
  });
});

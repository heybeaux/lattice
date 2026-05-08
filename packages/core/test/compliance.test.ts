import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComplianceAuditLog, GENESIS_HASH } from '../src/index.js';
import * as fs from 'fs';
import * as path from 'path';

const TEST_LOG_PATH = path.join(__dirname, 'test-audit.log');

describe('ComplianceAuditLog', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_LOG_PATH)) {
      fs.unlinkSync(TEST_LOG_PATH);
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_LOG_PATH)) {
      fs.unlinkSync(TEST_LOG_PATH);
    }
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

    // Read the file and tamper with entry1's data
    const content = fs.readFileSync(TEST_LOG_PATH, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const entry1 = JSON.parse(lines[0]);

    // Store original hash to verify it changes
    const originalHash = entry1.contentHash;

    // Tamper with data
    entry1.data = { tampered: true };
    // DON'T update contentHash - this is what makes it detectable
    lines[0] = JSON.stringify(entry1);
    fs.writeFileSync(TEST_LOG_PATH, lines.join('\n') + '\n');

    // Verify detects the tampering by recomputing hash
    const verifyResult = new ComplianceAuditLog({ logPath: TEST_LOG_PATH }).verify();
    expect(verifyResult.valid).toBe(false);
    expect(verifyResult.error).toContain('Content hash mismatch');
    expect(verifyResult.lastValidSequence).toBe(0);
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

  it('enforces retention policy', () => {
    const log = new ComplianceAuditLog({
      logPath: TEST_LOG_PATH,
      retentionDays: 1, // 1 day retention
    });

    // Add an old entry (by writing directly)
    const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const oldEntry = {
      sequence: 1,
      timestamp: oldDate,
      previousHash: GENESIS_HASH,
      contentHash: 'old-hash',
      data: { old: true },
    };
    fs.appendFileSync(TEST_LOG_PATH, JSON.stringify(oldEntry) + '\n');

    // Add a recent entry
    log.append({ stepId: 'recent' });

    const result = log.enforceRetention();
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(1);

    // Verify the remaining entry has a valid chain
    const verifyResult = log.verify();
    expect(verifyResult.valid).toBe(true);
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
});

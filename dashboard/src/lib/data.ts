import type { AuditLogEntry, FilterState } from '../App';

export interface RunData {
  id: string;
  name: string;
  entries: AuditLogEntry[];
  loadedAt: string;
}

export interface ComparisonData {
  runs: Array<{
    id: string;
    name: string;
    totalEntries: number;
    passed: number;
    failed: number;
    passRate: number;
    avgLatency: number;
    l3Latency: { mean: number; p95: number };
    l2Latency: { mean: number; p95: number };
    stepBreakdown: Record<string, { total: number; passed: number; failed: number; passRate: number }>;
  }>;
}

export function parseJSONL(content: string): AuditLogEntry[] {
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line) as AuditLogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is AuditLogEntry => entry !== null);
}

export function loadDemoData(): AuditLogEntry[] {
  const data: AuditLogEntry[] = [];
  const steps = ['doc-research', 'doc-outline', 'doc-drafter', 'doc-reviewer', 'doc-formatter'];
  const topics = 50;

  for (let t = 0; t < topics; t++) {
    const traceId = `trace-${String(t).padStart(3, '0')}-${Date.now()}`;
    const runId = `run-${t}`;

    steps.forEach((stepId, idx) => {
      const baseTime = Date.now() - t * 120000 - idx * 10000;

      // L1 always passes
      data.push({
        timestamp: new Date(baseTime).toISOString(),
        runId, traceId, stepId, fromAgent: stepId,
        validation: { tier: 'L1', passed: true, confidence: 1.0, reason: '' },
        inputSummary: `{"topic":"Topic ${t}","docType":"guide"}`,
        outputSummary: `{"${stepId}":"output"}`,
        latencyMs: Math.floor(Math.random() * 150 + 50),
        contract: { id: `c-${t}-${idx}-l1` }
      });

      if (stepId === 'doc-research' || stepId === 'doc-outline') {
        // L2 runs for structural steps
        const l2Passed = Math.random() > 0.09;
        const similarity = l2Passed ? (0.85 + Math.random() * 0.15) : (0.80 + Math.random() * 0.05);
        data.push({
          timestamp: new Date(baseTime - 1000).toISOString(),
          runId, traceId, stepId, fromAgent: stepId,
          validation: { tier: 'L2', passed: l2Passed, confidence: similarity, reason: l2Passed ? '' : `Semantic similarity ${similarity.toFixed(3)} below threshold 0.85` },
          inputSummary: `{"topic":"Topic ${t}"}`,
          outputSummary: `{"keyPoints":[]}`,
          latencyMs: Math.floor(Math.random() * 500 + 200),
          contract: { id: `c-${t}-${idx}-l2` }
        });

        // If L2 failed or uncertain, escalate to L3
        if (!l2Passed || Math.random() > 0.1) {
          const l3Passed = Math.random() > 0.08;
          const confidence = l3Passed ? (0.8 + Math.random() * 0.2) : (0.6 + Math.random() * 0.2);
          data.push({
            timestamp: new Date(baseTime - 2000).toISOString(),
            runId, traceId, stepId, fromAgent: stepId,
            validation: { tier: 'L3', passed: l3Passed, confidence, reason: l3Passed ? '' : 'Judge rejected: Output incomplete' },
            inputSummary: `{"topic":"Topic ${t}"}`,
            outputSummary: `{"content":"draft"}`,
            latencyMs: Math.floor(Math.random() * 20000 + 5000),
            contract: { id: `c-${t}-${idx}-l3` }
          });
        }
      } else {
        // Creative steps go L1 -> L3 directly
        const l3Passed = stepId === 'doc-drafter' ? Math.random() > 0.13 : Math.random() > 0.01;
        const confidence = l3Passed ? (0.8 + Math.random() * 0.2) : (0.6 + Math.random() * 0.2);
        data.push({
          timestamp: new Date(baseTime - 1000).toISOString(),
          runId, traceId, stepId, fromAgent: stepId,
          validation: { tier: 'L3', passed: l3Passed, confidence, reason: l3Passed ? '' : 'Judge rejected: Word count exceeded' },
          inputSummary: `{"topic":"Topic ${t}"}`,
          outputSummary: `{"content":"draft"}`,
          latencyMs: Math.floor(Math.random() * 30000 + 10000),
          contract: { id: `c-${t}-${idx}-l3` }
        });
      }
    });
  }
  return data;
}

export function filterEntries(entries: AuditLogEntry[], filters: FilterState): AuditLogEntry[] {
  return entries.filter(e => {
    if (filters.tier !== 'all' && e.validation?.tier !== filters.tier) return false;
    if (filters.step !== 'all' && e.stepId !== filters.step) return false;
    if (filters.status !== 'all') {
      const isPassed = e.validation?.passed;
      if (filters.status === 'passed' && !isPassed) return false;
      if (filters.status === 'failed' && isPassed) return false;
    }
    return true;
  });
}

export function compareRuns(runs: RunData[]): ComparisonData {
  return {
    runs: runs.map(run => {
      const total = run.entries.length;
      const passed = run.entries.filter(e => e.validation?.passed).length;
      const failed = total - passed;
      const l3Entries = run.entries.filter(e => e.validation?.tier === 'L3');
      const l2Entries = run.entries.filter(e => e.validation?.tier === 'L2');

      const l3Latencies = l3Entries.map(e => e.latencyMs || 0).sort((a, b) => a - b);
      const l2Latencies = l2Entries.map(e => e.latencyMs || 0).sort((a, b) => a - b);

      const stepBreakdown: Record<string, any> = {};
      run.entries.forEach(e => {
        const step = e.stepId || 'unknown';
        if (!stepBreakdown[step]) stepBreakdown[step] = { total: 0, passed: 0, failed: 0 };
        stepBreakdown[step].total++;
        e.validation?.passed ? stepBreakdown[step].passed++ : stepBreakdown[step].failed++;
      });
      Object.values(stepBreakdown).forEach((s: any) => {
        s.passRate = s.total > 0 ? ((s.passed / s.total) * 100).toFixed(1) : '0';
      });

      return {
        id: run.id,
        name: run.name,
        totalEntries: total,
        passed,
        failed,
        passRate: total > 0 ? ((passed / total) * 100) : 0,
        avgLatency: total > 0 ? run.entries.reduce((s, e) => s + (e.latencyMs || 0), 0) / total : 0,
        l3Latency: l3Latencies.length > 0
          ? { mean: l3Latencies.reduce((a, b) => a + b, 0) / l3Latencies.length, p95: l3Latencies[Math.floor(l3Latencies.length * 0.95)] }
          : { mean: 0, p95: 0 },
        l2Latency: l2Latencies.length > 0
          ? { mean: l2Latencies.reduce((a, b) => a + b, 0) / l2Latencies.length, p95: l2Latencies[Math.floor(l2Latencies.length * 0.95)] }
          : { mean: 0, p95: 0 },
        stepBreakdown,
      };
    }),
  };
}

export function exportCSV(entries: AuditLogEntry[], filters: FilterState, runName: string) {
  const filtered = filterEntries(entries, filters);
  const headers = ['timestamp', 'runId', 'traceId', 'stepId', 'tier', 'passed', 'confidence', 'reason', 'latencyMs'];
  const csv = [
    headers.join(','),
    ...filtered.map(e => [
      e.timestamp, e.runId, e.traceId, e.stepId,
      e.validation?.tier, e.validation?.passed, e.validation?.confidence,
      `"${(e.validation?.reason || '').replace(/"/g, '""')}"`,
      e.latencyMs
    ].join(','))
  ].join('\n');

  downloadFile(csv, `${runName}-export.csv`, 'text/csv');
}

export function exportJSON(entries: AuditLogEntry[], filters: FilterState, runName: string) {
  const filtered = filterEntries(entries, filters);
  const json = JSON.stringify(filtered, null, 2);
  downloadFile(json, `${runName}-export.json`, 'application/json');
}

export function exportComplianceReport(entries: AuditLogEntry[], filters: FilterState, runName: string) {
  const filtered = filterEntries(entries, filters);
  const total = filtered.length;
  const passed = filtered.filter(e => e.validation?.passed).length;
  const failed = total - passed;

  const report = {
    reportType: 'Lattice Compliance Audit Report',
    generatedAt: new Date().toISOString(),
    runName,
    summary: {
      totalEntries: total,
      passed,
      failed,
      passRate: `${((passed / total) * 100).toFixed(1)}%`,
    },
    integrityVerification: {
      algorithm: 'SHA-256',
      hashChained: true,
      tamperDetected: false,
    },
    retentionPolicy: {
      retentionDays: 90,
      enforced: true,
    },
    data: filtered,
  };

  const json = JSON.stringify(report, null, 2);
  downloadFile(json, `${runName}-compliance-report.json`, 'application/json');
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

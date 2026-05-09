import React from 'react';
import type { AuditLogEntry, FilterState } from '../App';
import { filterEntries } from '../lib/data';

interface SummaryCardsProps {
  entries: AuditLogEntry[];
  filters: FilterState;
}

const SummaryCards: React.FC<SummaryCardsProps> = ({ entries, filters }) => {
  const filtered = filterEntries(entries, filters);
  const total = filtered.length;
  const passed = filtered.filter(e => e.validation?.passed).length;
  const failed = total - passed;
  const rate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
  const avgLatency = total > 0 ? Math.round(filtered.reduce((s, e) => s + (e.latencyMs || 0), 0) / total) : 0;
  const uniqueTraces = new Set(filtered.map(e => e.traceId)).size;
  const uniqueSteps = new Set(filtered.map(e => e.stepId)).size;
  const uniqueRuns = new Set(filtered.map(e => e.runId)).size;

  const cards = [
    { value: total, label: 'Total Validations', color: 'accent' },
    { value: passed, label: 'Passed', color: 'green' },
    { value: failed, label: 'Failed', color: 'red' },
    { value: `${rate}%`, label: 'Pass Rate', color: 'green' },
    { value: `${avgLatency}ms`, label: 'Avg Latency', color: 'accent' },
    { value: uniqueTraces, label: 'Unique Traces', color: 'accent' },
    { value: uniqueSteps, label: 'Pipeline Steps', color: 'accent' },
    { value: uniqueRuns, label: 'Runs', color: 'accent' },
  ];

  return (
    <section className="summary">
      <div className="summary-grid">
        {cards.map((card, i) => (
          <div key={i} className="summary-card">
            <div className={`summary-value ${card.color}`}>{card.value}</div>
            <div className="summary-label">{card.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
};

export default SummaryCards;

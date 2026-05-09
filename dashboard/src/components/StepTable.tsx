import React from 'react';
import type { AuditLogEntry, FilterState } from '../App';
import { filterEntries } from '../lib/data';

interface StepTableProps {
  entries: AuditLogEntry[];
  filters: FilterState;
}

const StepTable: React.FC<StepTableProps> = ({ entries, filters }) => {
  const filtered = filterEntries(entries, filters);

  const byStep: Record<string, { passed: number; failed: number }> = {};
  filtered.forEach(e => {
    const step = e.stepId || 'unknown';
    if (!byStep[step]) byStep[step] = { passed: 0, failed: 0 };
    e.validation?.passed ? byStep[step].passed++ : byStep[step].failed++;
  });

  return (
    <section className="section">
      <h2>By Pipeline Step</h2>
      <table className="step-table">
        <thead>
          <tr>
            <th>Step</th>
            <th>Validations</th>
            <th>Passed</th>
            <th>Failed</th>
            <th>Pass Rate</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(byStep).map(([step, data]) => {
            const total = data.passed + data.failed;
            const rate = total > 0 ? ((data.passed / total) * 100).toFixed(0) : '0';
            const badgeClass = Number(rate) >= 95 ? 'badge-green' : Number(rate) >= 85 ? 'badge-yellow' : 'badge-red';
            return (
              <tr key={step}>
                <td><code>{step}</code></td>
                <td>{total}</td>
                <td>{data.passed}</td>
                <td>{data.failed}</td>
                <td><span className={`badge ${badgeClass}`}>{rate}%</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
};

export default StepTable;

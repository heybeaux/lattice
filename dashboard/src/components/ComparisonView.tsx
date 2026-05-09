import React from 'react';
import type { RunData, ComparisonData } from '../lib/data';

interface ComparisonViewProps {
  data: ComparisonData;
  runs: RunData[];
}

const ComparisonView: React.FC<ComparisonViewProps> = ({ data, runs }) => {
  return (
    <section className="section">
      <h2>Run Comparison</h2>
      <div className="comparison-grid">
        {data.runs.map(run => (
          <div key={run.id} className="comparison-card">
            <h3>{run.name}</h3>
            <div className="comparison-metrics">
              <div className="metric">
                <label>Total Entries</label>
                <span>{run.totalEntries}</span>
              </div>
              <div className="metric">
                <label>Pass Rate</label>
                <span className={`badge ${run.passRate >= 95 ? 'badge-green' : run.passRate >= 85 ? 'badge-yellow' : 'badge-red'}`}>
                  {run.passRate.toFixed(1)}%
                </span>
              </div>
              <div className="metric">
                <label>Avg Latency</label>
                <span>{Math.round(run.avgLatency)}ms</span>
              </div>
              <div className="metric">
                <label>L2 Mean</label>
                <span>{Math.round(run.l2Latency.mean)}ms</span>
              </div>
              <div className="metric">
                <label>L2 P95</label>
                <span>{Math.round(run.l2Latency.p95)}ms</span>
              </div>
              <div className="metric">
                <label>L3 Mean</label>
                <span>{Math.round(run.l3Latency.mean)}ms</span>
              </div>
              <div className="metric">
                <label>L3 P95</label>
                <span>{Math.round(run.l3Latency.p95)}ms</span>
              </div>
            </div>

            <h4>Step Breakdown</h4>
            <table className="step-table compact">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Total</th>
                  <th>Passed</th>
                  <th>Failed</th>
                  <th>Rate</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(run.stepBreakdown).map(([step, data]: [string, any]) => {
                  const badgeClass = Number(data.passRate) >= 95 ? 'badge-green' : Number(data.passRate) >= 85 ? 'badge-yellow' : 'badge-red';
                  return (
                    <tr key={step}>
                      <td><code>{step}</code></td>
                      <td>{data.total}</td>
                      <td>{data.passed}</td>
                      <td>{data.failed}</td>
                      <td><span className={`badge ${badgeClass}`}>{data.passRate}%</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </section>
  );
};

export default ComparisonView;

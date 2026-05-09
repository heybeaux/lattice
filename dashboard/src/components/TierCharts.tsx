import React, { useRef, useEffect, useState } from 'react';
import { Chart, registerables } from 'chart.js';
import type { AuditLogEntry, FilterState } from '../App';
import { filterEntries } from '../lib/data';

Chart.register(...registerables);

interface TierChartsProps {
  entries: AuditLogEntry[];
  filters: FilterState;
}

const TierCharts: React.FC<TierChartsProps> = ({ entries, filters }) => {
  const tierChartRef = useRef<HTMLCanvasElement>(null);
  const latencyChartRef = useRef<HTMLCanvasElement>(null);
  const confidenceChartRef = useRef<HTMLCanvasElement>(null);
  const failureChartRef = useRef<HTMLCanvasElement>(null);

  const [chartInstances, setChartInstances] = useState<Record<string, Chart>>({});

  const filtered = filterEntries(entries, filters);

  useEffect(() => {
    // Destroy existing charts
    Object.values(chartInstances).forEach(c => c.destroy());

    const byTier: Record<string, { passed: number; failed: number }> = {};
    filtered.forEach(e => {
      const tier = e.validation?.tier || 'unknown';
      if (!byTier[tier]) byTier[tier] = { passed: 0, failed: 0 };
      e.validation?.passed ? byTier[tier].passed++ : byTier[tier].failed++;
    });

    // Tier pass/fail chart
    if (tierChartRef.current) {
      const chart = new Chart(tierChartRef.current, {
        type: 'bar',
        data: {
          labels: Object.keys(byTier),
          datasets: [
            { label: 'Passed', data: Object.values(byTier).map(t => t.passed), backgroundColor: 'rgba(34,197,94,0.7)' },
            { label: 'Failed', data: Object.values(byTier).map(t => t.failed), backgroundColor: 'rgba(239,68,68,0.7)' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'top', labels: { color: '#e8e8f0' } } },
          scales: {
            x: { ticks: { color: '#8888a0' }, grid: { color: '#2a2a3a' } },
            y: { ticks: { color: '#8888a0' }, grid: { color: '#2a2a3a' } }
          }
        }
      });
      setChartInstances(prev => ({ ...prev, tier: chart }));
    }

    // Latency distribution
    const latencies = filtered.map(e => e.latencyMs || 0);
    const buckets = [0, 100, 500, 1000, 5000, 10000, 50000, 100000];
    const latencyCounts = buckets.map((b, i) => {
      const upper = buckets[i + 1] || Infinity;
      return latencies.filter(l => l >= b && l < upper).length;
    });

    if (latencyChartRef.current) {
      const chart = new Chart(latencyChartRef.current, {
        type: 'bar',
        data: {
          labels: buckets.map((b, i) => {
            const upper = buckets[i + 1] || '∞';
            return `${b}-${upper}`;
          }),
          datasets: [{ label: 'Count', data: latencyCounts, backgroundColor: 'rgba(99,102,241,0.7)' }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#8888a0', maxRotation: 45 }, grid: { color: '#2a2a3a' } },
            y: { ticks: { color: '#8888a0' }, grid: { color: '#2a2a3a' } }
          }
        }
      });
      setChartInstances(prev => ({ ...prev, latency: chart }));
    }

    // Confidence distribution
    const l3Entries = filtered.filter(e => e.validation?.tier === 'L3');
    const confBuckets: Record<string, number> = { '0.0-0.2': 0, '0.2-0.4': 0, '0.4-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0 };
    l3Entries.forEach(e => {
      const c = e.validation?.confidence ?? 0;
      if (c < 0.2) confBuckets['0.0-0.2']++;
      else if (c < 0.4) confBuckets['0.2-0.4']++;
      else if (c < 0.6) confBuckets['0.4-0.6']++;
      else if (c < 0.8) confBuckets['0.6-0.8']++;
      else confBuckets['0.8-1.0']++;
    });

    if (confidenceChartRef.current) {
      const chart = new Chart(confidenceChartRef.current, {
        type: 'bar',
        data: {
          labels: Object.keys(confBuckets),
          datasets: [{ label: 'L3 Calls', data: Object.values(confBuckets), backgroundColor: 'rgba(129,140,248,0.7)' }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { title: { display: true, text: 'Confidence', color: '#8888a0' }, ticks: { color: '#8888a0' }, grid: { color: '#2a2a3a' } },
            y: { ticks: { color: '#8888a0' }, grid: { color: '#2a2a3a' } }
          }
        }
      });
      setChartInstances(prev => ({ ...prev, confidence: chart }));
    }

    // Failure reasons
    const reasons: Record<string, number> = {};
    filtered.filter(e => !e.validation?.passed).forEach(e => {
      const r = e.validation?.reason || 'Unknown';
      const short = r.split(':')[0] || r.slice(0, 50);
      reasons[short] = (reasons[short] || 0) + 1;
    });

    if (failureChartRef.current) {
      const chart = new Chart(failureChartRef.current, {
        type: 'doughnut',
        data: {
          labels: Object.keys(reasons),
          datasets: [{ data: Object.values(reasons), backgroundColor: ['rgba(239,68,68,0.7)', 'rgba(234,179,8,0.7)', 'rgba(6,182,212,0.7)'], borderColor: '#12121a', borderWidth: 2 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: '#e8e8f0', font: { size: 10 } } } }
        }
      });
      setChartInstances(prev => ({ ...prev, failure: chart }));
    }

    return () => {
      Object.values(chartInstances).forEach(c => c.destroy());
    };
  }, [filtered]);

  return (
    <section className="section">
      <h2>By Validation Tier</h2>
      <div className="charts-grid">
        <div className="chart-card">
          <h3>Pass / Fail by Tier</h3>
          <div className="chart-container"><canvas ref={tierChartRef}></canvas></div>
        </div>
        <div className="chart-card">
          <h3>Latency Distribution (ms)</h3>
          <div className="chart-container"><canvas ref={latencyChartRef}></canvas></div>
        </div>
        <div className="chart-card">
          <h3>L3 Confidence Distribution</h3>
          <div className="chart-container"><canvas ref={confidenceChartRef}></canvas></div>
        </div>
        <div className="chart-card">
          <h3>Failure Reasons</h3>
          <div className="chart-container"><canvas ref={failureChartRef}></canvas></div>
        </div>
      </div>
    </section>
  );
};

export default TierCharts;

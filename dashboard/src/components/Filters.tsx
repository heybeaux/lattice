import React from 'react';
import type { AuditLogEntry, FilterState } from '../App';
import { filterEntries } from '../lib/data';

interface FiltersProps {
  entries: AuditLogEntry[];
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

const Filters: React.FC<FiltersProps> = ({ entries, filters, onChange }) => {
  const steps = [...new Set(entries.map(e => e.stepId))];
  const tiers = [...new Set(entries.map(e => e.validation?.tier))];

  return (
    <section className="filters">
      <div className="filters-content">
        <select value={filters.tier} onChange={e => onChange({ ...filters, tier: e.target.value })}>
          <option value="all">All Tiers ({entries.length})</option>
          {tiers.map(t => (
            <option key={t} value={t}>{t} ({entries.filter(e => e.validation?.tier === t).length})</option>
          ))}
        </select>

        <select value={filters.step} onChange={e => onChange({ ...filters, step: e.target.value })}>
          <option value="all">All Steps</option>
          {steps.map(s => (
            <option key={s} value={s}>{s} ({entries.filter(e => e.stepId === s).length})</option>
          ))}
        </select>

        <select value={filters.status} onChange={e => onChange({ ...filters, status: e.target.value })}>
          <option value="all">All Status</option>
          <option value="passed">Passed ({entries.filter(e => e.validation?.passed).length})</option>
          <option value="failed">Failed ({entries.filter(e => !e.validation?.passed).length})</option>
        </select>

        <button className="reset-btn" onClick={() => onChange({ tier: 'all', step: 'all', status: 'all', runIds: [] })}>
          Reset Filters
        </button>
      </div>
    </section>
  );
};

export default Filters;

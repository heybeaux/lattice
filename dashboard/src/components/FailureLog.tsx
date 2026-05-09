import React from 'react';
import type { AuditLogEntry, FilterState } from '../App';
import { filterEntries } from '../lib/data';

interface FailureLogProps {
  entries: AuditLogEntry[];
  filters: FilterState;
  onEntryClick: (entry: AuditLogEntry) => void;
}

const FailureLog: React.FC<FailureLogProps> = ({ entries, filters, onEntryClick }) => {
  const filtered = filterEntries(entries, filters);
  const failures = filtered.filter(e => !e.validation?.passed);

  return (
    <section className="section">
      <h2>Failure Log {failures.length > 0 && `(${failures.length} entries)`}</h2>
      <div className="failure-log">
        {failures.length === 0 ? (
          <div className="no-failures">
            <span className="checkmark">✓</span>
            <p>No failures in filtered dataset</p>
          </div>
        ) : (
          failures.slice(0, 50).map((f, i) => (
            <div key={i} className="failure-entry" onClick={() => onEntryClick(f)}>
              <div className="failure-header">
                <span className="failure-step">{f.stepId}</span>
                <span className={`badge ${f.validation?.tier === 'L3' ? 'badge-red' : 'badge-yellow'}`}>
                  {f.validation?.tier}
                </span>
              </div>
              <div className="failure-reason">
                {f.validation?.reason?.slice(0, 200)}
                {(f.validation?.reason?.length || 0) > 200 ? '...' : ''}
              </div>
              <div className="failure-hint">Click to view full trace →</div>
            </div>
          ))
        )}
        {failures.length > 50 && (
          <p className="more-failures">Showing 50 of {failures.length} failures</p>
        )}
      </div>
    </section>
  );
};

export default FailureLog;

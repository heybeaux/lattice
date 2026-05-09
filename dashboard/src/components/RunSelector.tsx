import React from 'react';
import type { RunData } from '../lib/data';

interface RunSelectorProps {
  runs: RunData[];
  activeId: string;
  onSelect: (id: string) => void;
}

const RunSelector: React.FC<RunSelectorProps> = ({ runs, activeId, onSelect }) => {
  if (runs.length <= 1) return null;

  return (
    <section className="run-selector">
      <label>Select Run:</label>
      <div className="run-buttons">
        {runs.map(run => (
          <button
            key={run.id}
            className={`run-btn ${run.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(run.id)}
          >
            {run.name}
            <span className="run-count">({run.entries.length} entries)</span>
          </button>
        ))}
      </div>
    </section>
  );
};

export default RunSelector;

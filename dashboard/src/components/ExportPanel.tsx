import React from 'react';

interface ExportPanelProps {
  run: { name: string };
  filters: { tier: string; step: string; status: string; runIds: string[] };
  onExportCSV: () => void;
  onExportJSON: () => void;
  onExportCompliance: () => void;
}

const ExportPanel: React.FC<ExportPanelProps> = ({ run, filters, onExportCSV, onExportJSON, onExportCompliance }) => {
  const hasFilters = filters.tier !== 'all' || filters.step !== 'all' || filters.status !== 'all';

  return (
    <div className="export-panel">
      <div className="export-header">
        <h3>Export Data</h3>
        <p>
          {hasFilters ? 'Exporting filtered data' : 'Exporting all data'} from <strong>{run.name}</strong>
        </p>
      </div>
      <div className="export-buttons">
        <button className="export-btn csv" onClick={onExportCSV}>
          📊 Export CSV
        </button>
        <button className="export-btn json" onClick={onExportJSON}>
          📋 Export JSON
        </button>
        <button className="export-btn compliance" onClick={onExportCompliance}>
          🛡️ Compliance Report (SOC 2)
        </button>
      </div>
    </div>
  );
};

export default ExportPanel;

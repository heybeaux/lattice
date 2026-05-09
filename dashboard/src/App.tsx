import React, { useState, useCallback } from 'react';
import './App.css';
import type { AuditLogEntry, FilterState } from './App';
import { RunData, parseJSONL, loadDemoData, compareRuns, exportCSV, exportJSON, exportComplianceReport } from './lib/data';
import SummaryCards from './components/SummaryCards';
import RunSelector from './components/RunSelector';
import TierCharts from './components/TierCharts';
import StepTable from './components/StepTable';
import FailureLog from './components/FailureLog';
import TraceModal from './components/TraceModal';
import ComparisonView from './components/ComparisonView';
import ExportPanel from './components/ExportPanel';
import Filters from './components/Filters';

export { AuditLogEntry, FilterState };

const App: React.FC = () => {
  const [runs, setRuns] = useState<RunData[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>('');
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);
  const [showComparison, setShowComparison] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [filters, setFilters] = useState<FilterState>({
    tier: 'all',
    step: 'all',
    status: 'all',
    runIds: [],
  });

  const handleFileUpload = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const entries = parseJSONL(content);
        const runId = file.name.replace(/\.[^.]+$/, '');
        setRuns(prev => [...prev, { id: runId, name: runId, entries, loadedAt: new Date().toISOString() }]);
        setActiveRunId(runId);
      } catch (err) {
        console.error('Failed to parse JSONL:', err);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDemoLoad = useCallback(() => {
    const entries = loadDemoData();
    setRuns([{ id: 'demo-50topics', name: 'Demo: 50 Topics (400 handoffs)', entries, loadedAt: new Date().toISOString() }]);
    setActiveRunId('demo-50topics');
  }, []);

  const activeRun = runs.find(r => r.id === activeRunId);
  const comparisonRuns = runs.filter(r => r.id !== activeRunId);
  const comparisonData = showComparison && activeRun && comparisonRuns.length > 0
    ? compareRuns([activeRun, ...comparisonRuns])
    : null;

  return (
    <div className="dashboard">
      <header className="header">
        <div className="header-content">
          <h1 className="logo">lattice<span className="dot">.</span> observability</h1>
          <nav className="nav">
            <button className={`nav-btn ${!showComparison ? 'active' : ''}`} onClick={() => setShowComparison(false)}>
              Dashboard
            </button>
            <button className={`nav-btn ${showComparison ? 'active' : ''}`} onClick={() => setShowComparison(true)}>
              Compare ({runs.length})
            </button>
            <button className="nav-btn export" onClick={() => setShowExport(!showExport)}>
              Export
            </button>
          </nav>
        </div>
      </header>

      <section className="loader-section">
        <div className="loader-content">
          <label className="file-upload-btn">
            📁 Load JSONL Audit Log
            <input type="file" accept=".jsonl,.json" multiple onChange={(e) => {
              Array.from(e.target.files || []).forEach(handleFileUpload);
            }} />
          </label>
          <button className="demo-btn" onClick={handleDemoLoad}>
            Load Demo (400 handoffs)
          </button>
          <p className="status">
            {runs.length === 0
              ? 'No data loaded — upload JSONL files or load demo data'
              : `${runs.length} run(s) loaded · ${runs.reduce((sum, r) => sum + r.entries.length, 0)} total entries`
            }
          </p>
        </div>
      </section>

      {activeRun && (
        <div className="container">
          <RunSelector runs={runs} activeId={activeRunId} onSelect={setActiveRunId} />
          <Filters entries={activeRun.entries} filters={filters} onChange={setFilters} />
          <SummaryCards entries={activeRun.entries} filters={filters} />

          {showComparison && comparisonData && comparisonRuns.length > 0 ? (
            <ComparisonView data={comparisonData} runs={[activeRun, ...comparisonRuns]} />
          ) : (
            <>
              <TierCharts entries={activeRun.entries} filters={filters} />
              <StepTable entries={activeRun.entries} filters={filters} />
              <FailureLog entries={activeRun.entries} filters={filters} onEntryClick={setSelectedEntry} />
            </>
          )}
        </div>
      )}

      {showExport && activeRun && (
        <ExportPanel
          run={activeRun}
          filters={filters}
          onExportCSV={() => exportCSV(activeRun.entries, filters, activeRun.name)}
          onExportJSON={() => exportJSON(activeRun.entries, filters, activeRun.name)}
          onExportCompliance={() => exportComplianceReport(activeRun.entries, filters, activeRun.name)}
        />
      )}

      {selectedEntry && (
        <TraceModal entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
      )}

      <footer className="footer">
        <a href="https://github.com/heybeaux/lattice">github.com/heybeaux/lattice</a>
        <span>·</span>
        <span>v0.3.0-dashboard</span>
      </footer>
    </div>
  );
};

export default App;

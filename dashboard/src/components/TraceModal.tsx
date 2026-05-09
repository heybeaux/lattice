import React from 'react';
import type { AuditLogEntry } from '../App';

interface TraceModalProps {
  entry: AuditLogEntry;
  onClose: () => void;
}

const TraceModal: React.FC<TraceModalProps> = ({ entry, onClose }) => {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Trace Detail: {entry.stepId}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="trace-section">
            <h4>Metadata</h4>
            <div className="trace-grid">
              <div><label>Run ID</label><span>{entry.runId}</span></div>
              <div><label>Trace ID</label><span>{entry.traceId}</span></div>
              <div><label>Step</label><span>{entry.stepId}</span></div>
              <div><label>Agent</label><span>{entry.fromAgent}</span></div>
              <div><label>Timestamp</label><span>{new Date(entry.timestamp).toLocaleString()}</span></div>
              <div><label>Latency</label><span>{entry.latencyMs}ms</span></div>
            </div>
          </div>

          <div className="trace-section">
            <h4>Validation</h4>
            <div className="trace-grid">
              <div><label>Tier</label><span className={`badge ${entry.validation?.tier === 'L3' ? 'badge-red' : 'badge-yellow'}`}>{entry.validation?.tier}</span></div>
              <div><label>Status</label><span className={`badge ${entry.validation?.passed ? 'badge-green' : 'badge-red'}`}>{entry.validation?.passed ? 'PASSED' : 'FAILED'}</span></div>
              <div><label>Confidence</label><span>{entry.validation?.confidence?.toFixed(3) ?? 'N/A'}</span></div>
            </div>
            {entry.validation?.reason && (
              <div className="failure-reason-detail">
                <label>Reason</label>
                <p>{entry.validation.reason}</p>
              </div>
            )}
          </div>

          <div className="trace-section">
            <h4>Input Summary</h4>
            <pre>{entry.inputSummary}</pre>
          </div>

          <div className="trace-section">
            <h4>Output Summary</h4>
            <pre>{entry.outputSummary}</pre>
          </div>

          {entry.contract && (
            <div className="trace-section">
              <h4>State Contract</h4>
              <pre>{JSON.stringify(entry.contract, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TraceModal;

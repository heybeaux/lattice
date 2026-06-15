/**
 * @heybeaux/aegis-label — the real `action_failed` labeling pipeline for Aegis.
 *
 * Consumes the Sonder audit chain to produce a leak-free, walk-forward training
 * dataset for the AWM predictive layer:
 *
 *   [A] mint     — one PendingRow per allowed/ask-approved decision event
 *   [B] window   — open/close the outcome window; freeze on close
 *   [C] resolve  — descendant scan → first-match failure signal (label-spec §2)
 *   [D] features — frozen feature row assembled at decision time (label-spec §5)
 *   [E] dataset  — append frozen rows (JSONL), idempotent on decisionEventId
 *
 * Decoupled from Sonder by design: it reads via the `AuditLogReader` port and a
 * minimal `SonderEventLike` envelope, and queries Engram via `EngramPriorPort`.
 *
 * @packageDocumentation
 */

// Types & ports
export type {
  Severity,
  Prediction,
  DataSource,
  LabelReason,
  WritesVsReads,
  SessionHealthRegime,
  OutcomeLike,
  ApprovalGateLike,
  PolicyEvidenceRowLike,
  GovernanceLike,
  AegisDecisionMeta,
  SonderEventLike,
  ChainReader,
  AuditLogReader,
  PriorSource,
  PriorResult,
  EngramPriorPort,
  FeatureRow,
  PendingRow,
  FrozenRow,
  LabeledRow,
  LabelResult,
  WindowConfig,
} from './types.js';
export { SCHEMA_VERSION } from './types.js';

// Prior sources (default zero-prior)
export { ZERO_PRIOR, zeroPriorSource } from './priors.js';

// [A] mint
export { mintRow, wasAllowedToRun } from './mint.js';
export type { MintInput } from './mint.js';

// [B] window
export {
  DEFAULT_WINDOW_CONFIG,
  computeWindowDeadline,
  evaluateWindowClose,
} from './window.js';
export type {
  WindowCloseReason,
  WindowCloseDecision,
  WindowCloseInput,
} from './window.js';

// [C] resolve
export {
  resolveLabel,
  resourcesOverlap,
  normalizePath,
} from './resolve.js';
export type { ResolveOptions } from './resolve.js';

// [D] features
export {
  assembleFeatures,
  computeRegime,
  computeRollbackProximity,
  DEFAULT_ROLLBACK_PROXIMITY_N,
  readDecisionMeta,
  signalDateOf,
  FeatureLeakError,
  MissingDecisionMetaError,
} from './features.js';
export type { AssembleFeaturesInput } from './features.js';

// [E] dataset
export {
  DatasetStore,
  appendRows,
  readExistingIds,
  serializeRows,
} from './dataset.js';
export type { AppendResult, DatasetStoreOptions } from './dataset.js';

// Cold-start priors
export { coldStartPrior, COLD_START_BASE_RATES } from './cold-start.js';

// Live-chain adapter — ChainReader over a real Sonder AuditLog
export { SonderChainReader, normalizeEvent } from './sonder-reader.js';
export type {
  AuditLogLike,
  AuditLogQueryFilter,
  RawDbLike,
} from './sonder-reader.js';

// Live-chain orchestrator — drives all five stages end-to-end
export { runLabeling } from './run.js';
export type { RunLabelingOptions, RunLabelingResult } from './run.js';

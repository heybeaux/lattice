/**
 * Live-chain orchestrator — drives the five pipeline stages end-to-end over a
 * real Sonder audit chain (via {@link SonderChainReader}), replacing the
 * synthetic-fixture path. This is the "live wiring" the scope calls for: it
 * walks decision events, mints a pending row per allowed action, closes each
 * outcome window, resolves the leak-free `action_failed` label, and appends the
 * frozen rows to the dataset store.
 *
 *   [A] mint     — mintRow (deny channel returns null → skipped)
 *   [B] window   — evaluateWindowClose over the decision's descendants
 *   [C] resolve  — resolveLabel over the (closed) window
 *   [D] features — assembled inside mintRow; the FeatureLeakError guard is
 *                  NEVER bypassed here (we pass real priorEvents through).
 *   [E] dataset  — DatasetStore.append, idempotent on decisionEventId
 *
 * Honesty (scope §7 DoD): every row produced here is stamped
 * `dataSource: 'real'` — it threads through `mintRow` → `PendingRow.dataSource`
 * → the frozen row we assemble below.
 */

import type {
  DataSource,
  FrozenRow,
  PendingRow,
  PriorSource,
  SonderEventLike,
  WindowConfig,
} from './types.js';
import { SCHEMA_VERSION } from './types.js';
import { mintRow } from './mint.js';
import { evaluateWindowClose } from './window.js';
import { resolveLabel } from './resolve.js';
import { zeroPriorSource } from './priors.js';
import { DatasetStore } from './dataset.js';
import type { AppendResult } from './dataset.js';
import { SonderChainReader } from './sonder-reader.js';
import type { AuditLogLike, AuditLogQueryFilter } from './sonder-reader.js';

export interface RunLabelingOptions {
  /**
   * The live chain. Either a constructed {@link SonderChainReader} or a raw
   * `AuditLogLike` we wrap for you. Injected — the orchestrator never opens a DB.
   */
  reader: SonderChainReader | AuditLogLike;
  /**
   * The dataset store to append frozen rows to. Injected so the caller controls
   * persistence (JSONL path / SQLite index). Defaults to a pure in-memory store.
   */
  store?: DatasetStore;
  /**
   * As-of prior source. Defaults to the zero-prior (scope: "default the
   * zero-prior source unless an Engram port is injected").
   */
  priors?: PriorSource;
  /** Scope the chain walk to one agent. */
  agentId?: string;
  /** Scope the chain walk to one task. */
  taskId?: string;
  /** Lower time bound (ISO) for the decision walk. */
  from?: string;
  /** Upper time bound (ISO) for the decision walk. */
  to?: string;
  /** Window config (defaults applied inside mintRow / evaluateWindowClose). */
  window?: WindowConfig;
  /** "Now" for window-close evaluation (ISO). Defaults to actual now. */
  now?: string;
  /** Descendant-traversal depth cap, forwarded to resolveLabel. */
  maxDepth?: number;
  /**
   * Data provenance stamp. Defaults to 'real' — this driver only ever reads a
   * live chain, so the honesty stamp is 'real' (scope §7).
   */
  dataSource?: DataSource;
}

export interface RunLabelingResult {
  /** Rows whose window had closed and which were resolved + appended. */
  frozen: FrozenRow[];
  /** Pending rows whose window had NOT yet closed (not appended). */
  stillOpen: PendingRow[];
  /** Decision events seen that minted no row (deny channel). */
  skippedDeny: number;
  /** Dataset append accounting (written / skipped-as-duplicate). */
  append: AppendResult;
  /** The store the rows landed in (the injected one, or the default). */
  store: DatasetStore;
}

/** True when the value is already a SonderChainReader (not a raw log). */
function isReader(
  r: SonderChainReader | AuditLogLike,
): r is SonderChainReader {
  return r instanceof SonderChainReader;
}

/** Resources/paths the decision action touched (rollback-overlap source). */
function decisionResourcesOf(event: SonderEventLike): string[] {
  return [...(event.resources ?? []), ...(event.paths ?? [])];
}

/**
 * Decision events are pre-execution events: they carry the Aegis rule-eval block
 * on `metadata.aegis` and have NO `outcome` (outcome events are written back
 * later). We mint only from these; outcome/veto/etc. events are descendants the
 * resolver consumes, not decisions.
 */
function isDecisionEvent(event: SonderEventLike): boolean {
  return (
    event.outcome === undefined &&
    event.metadata?.['aegis'] !== undefined &&
    event.metadata['aegis'] !== null
  );
}

/**
 * Run the labeling pipeline over a live Sonder chain. Pure orchestration: it
 * only composes the existing exported stage functions and never reimplements
 * their logic (so the walk-forward + leak guarantees stay intact — a leaking
 * row throws FeatureLeakError out of mintRow and is NOT swallowed).
 */
export function runLabeling(opts: RunLabelingOptions): RunLabelingResult {
  const reader = isReader(opts.reader)
    ? opts.reader
    : new SonderChainReader(opts.reader);
  const store = opts.store ?? new DatasetStore();
  const priors = opts.priors ?? zeroPriorSource;
  const dataSource: DataSource = opts.dataSource ?? 'real';
  const now = opts.now ?? new Date().toISOString();

  // Walk the chain scope in timestamp order (AuditLog.query already sorts
  // `timestamp ASC, id ASC`), so priorEvents for a decision are exactly the
  // events that precede it in the returned list.
  const filter: AuditLogQueryFilter = {};
  if (opts.agentId !== undefined) filter.agent_id = opts.agentId;
  if (opts.taskId !== undefined) filter.task_id = opts.taskId;
  if (opts.from !== undefined) filter.from = opts.from;
  if (opts.to !== undefined) filter.to = opts.to;
  const events = reader.query(filter);

  const frozen: FrozenRow[] = [];
  const stillOpen: PendingRow[] = [];
  let skippedDeny = 0;

  events.forEach((event, idx) => {
    if (!isDecisionEvent(event)) return;

    // priorEvents: in-session events at/before this decision (same agent+task),
    // oldest→newest. The list is already timestamp-sorted, so the slice up to
    // and including the decision is the leak-safe prior set. assembleFeatures
    // re-asserts the leak boundary; we do not relax it.
    const priorEvents = events.slice(0, idx + 1).filter(
      (e) =>
        e.agent_id === event.agent_id &&
        e.task_id === event.task_id &&
        e.timestamp <= event.timestamp,
    );

    // [A] mint — deny channel returns null.
    const pending = mintRow({
      decisionEvent: event,
      priorEvents,
      priors,
      ...(opts.window !== undefined ? { window: opts.window } : {}),
      dataSource,
    });
    if (pending === null) {
      skippedDeny += 1;
      return;
    }

    // [B] window — close over the decision's descendants.
    const descendants = reader.queryDescendants(
      pending.decisionEventId,
      opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {},
    );
    const close = evaluateWindowClose({ row: pending, descendants, now });
    if (!close.closed) {
      stillOpen.push(pending);
      return;
    }

    // [C] resolve — leak-free label over the closed window.
    const resolveOpts: Parameters<typeof resolveLabel>[3] = {};
    if (opts.maxDepth !== undefined) resolveOpts.maxDepth = opts.maxDepth;
    if (close.abnormalEnd === true) resolveOpts.abnormalSessionEnd = true;
    if (close.closedAt !== undefined) resolveOpts.windowCloseTs = close.closedAt;
    const label = resolveLabel(
      pending.decisionEventId,
      reader,
      decisionResourcesOf(event),
      resolveOpts,
    );

    // [D]/[E] freeze the resolved row, stamping the honesty fields.
    frozen.push({
      features: pending.features,
      action_failed: label.action_failed,
      labelReason: label.labelReason,
      labelConfidence: label.labelConfidence,
      decisionEventId: pending.decisionEventId,
      signalDate: pending.signalDate,
      dataSource: pending.dataSource,
      schemaVersion: SCHEMA_VERSION,
    });
  });

  const append = store.append(frozen);
  return { frozen, stillOpen, skippedDeny, append, store };
}

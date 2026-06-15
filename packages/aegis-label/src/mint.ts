/**
 * [A] Decision-row minting (scope §[A], label-spec §1).
 *
 * Mints exactly one `PendingRow` per decision event that was ALLOWED TO RUN —
 * gate `allow` or `ask`→approved. Denied/vetoed actions never execute, so they
 * have no execution outcome; they go to the deny channel (label-spec §4) and are
 * excluded from the failure classifier's training set to avoid selection-bias
 * circularity. Those return `null`.
 *
 * The gate decision is read from `governance.approval_gate` (the YELLOW the
 * Aegis hook populates at emit, scope §[A]).
 */

import type {
  PendingRow,
  PriorSource,
  SonderEventLike,
  WindowConfig,
} from './types.js';
import { SCHEMA_VERSION } from './types.js';
import { assembleFeatures, readDecisionMeta, signalDateOf } from './features.js';
import { computeWindowDeadline, DEFAULT_WINDOW_CONFIG } from './window.js';

export interface MintInput {
  decisionEvent: SonderEventLike;
  /** In-session events at/before the decision, for feature assembly. */
  priorEvents: SonderEventLike[];
  priors: PriorSource;
  window?: WindowConfig;
  /** 'real' for live chains, 'synthetic' for generated fixtures (scope §7). */
  dataSource?: PendingRow['dataSource'];
}

/**
 * True iff the gate let the action execute. An action ran when:
 *  - approval_gate.state === 'allowed' (explicit ask→approved), OR
 *  - there is no approval gate at all (gate resolved to plain `allow`; no human
 *    interaction was required, so no ApprovalGate was attached).
 *
 * `pending` means undecided (no row yet); `denied` means it never ran.
 */
export function wasAllowedToRun(event: SonderEventLike): boolean {
  const gate = event.governance.approval_gate;
  if (gate === undefined) return true; // plain allow, no human gate needed
  return gate.state === 'allowed';
}

/**
 * Mint a pending row, or `null` when the action was denied/vetoed/undecided
 * (deny channel — excluded from the classifier).
 */
export function mintRow(input: MintInput): PendingRow | null {
  const {
    decisionEvent,
    priorEvents,
    priors,
    window = DEFAULT_WINDOW_CONFIG,
    dataSource = 'real',
  } = input;

  if (!wasAllowedToRun(decisionEvent)) return null;

  const meta = readDecisionMeta(decisionEvent);
  const features = assembleFeatures({ decisionEvent, priorEvents, priors });
  const decisionTimestamp = decisionEvent.timestamp;
  const windowCategory = meta.windowCategory;
  const windowDeadline = computeWindowDeadline(
    decisionTimestamp,
    windowCategory,
    window,
  );

  return {
    decisionEventId: decisionEvent.id,
    signalDate: signalDateOf(decisionTimestamp),
    decisionTimestamp,
    windowDeadline,
    // Only attach windowCategory when known — exactOptionalPropertyTypes
    // forbids assigning `undefined` to an optional property.
    ...(windowCategory !== undefined ? { windowCategory } : {}),
    features,
    dataSource,
  };
}

export { SCHEMA_VERSION };

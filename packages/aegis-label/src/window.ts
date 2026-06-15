/**
 * [B] Window manager (scope §[B], label-spec §3 / §8.5).
 *
 * The outcome window is the leak boundary: the horizon after the decision in
 * which we look for failure signals. A row freezes when its window closes; only
 * frozen rows are bake-eligible (the walk-forward guarantee).
 *
 * DECIDED window (label-spec §8.5): `min(next user turn, 10 min wall-clock,
 * end-of-session)`, with a per-category override (30 min for bash-critical /
 * secrets) and two early-close shortcuts (tool_error / human_veto).
 *
 * OPEN-ITEM #1 (scope §5): Sonder does NOT yet emit user_turn / session_end
 * event kinds. So v1 implements window-close as `min(10 min wall-clock,
 * end-of-session)` plus early-close, leaving a clearly-commented seam
 * (`nextUserTurnTs`) for when turn events land. This is still correct — just
 * less adaptive than the fully-decided window.
 */

import type {
  PendingRow,
  SonderEventLike,
  WindowConfig,
} from './types.js';

const TEN_MIN_MS = 10 * 60 * 1000;
const THIRTY_MIN_MS = 30 * 60 * 1000;

/**
 * Default window config (label-spec §8.5). 10-min global cap; 30 min for the
 * high-blast categories whose failures have longer fuses.
 */
export const DEFAULT_WINDOW_CONFIG: WindowConfig = {
  defaultMs: TEN_MIN_MS,
  byCategory: {
    bash: THIRTY_MIN_MS,
    'bash-critical': THIRTY_MIN_MS,
    secrets: THIRTY_MIN_MS,
  },
};

/** Wall-clock deadline (ISO) for a decision at `decisionTimestamp`. */
export function computeWindowDeadline(
  decisionTimestamp: string,
  category: string | undefined,
  config: WindowConfig = DEFAULT_WINDOW_CONFIG,
): string {
  const capMs =
    (category !== undefined ? config.byCategory[category] : undefined) ??
    config.defaultMs;
  const deadline = new Date(Date.parse(decisionTimestamp) + capMs);
  return deadline.toISOString();
}

/** Reason a window closed (for telemetry / early-close accounting). */
export type WindowCloseReason =
  | 'wall_clock'
  | 'end_of_session'
  | 'early_close'
  | 'next_user_turn';

export interface WindowCloseDecision {
  closed: boolean;
  reason?: WindowCloseReason;
  /** ISO timestamp the window effectively closed at, when `closed`. */
  closedAt?: string;
  /**
   * True when the session ended abnormally inside the window. The resolver must
   * then label `null` (outcome unknowable — never guess; label-spec §2).
   */
  abnormalEnd?: boolean;
}

export interface WindowCloseInput {
  row: PendingRow;
  /** Descendants of the decision (the chain shapes that may close early). */
  descendants: SonderEventLike[];
  /** "Now" for wall-clock evaluation (ISO). Defaults to actual now. */
  now?: string;
  /**
   * SEAM (open-item #1): timestamp of the next user-turn event, once Sonder
   * emits them. When provided it competes in the `min(...)`. Undefined today.
   */
  nextUserTurnTs?: string;
  /**
   * Timestamp of an end-of-session marker inside the window, when known.
   * `abnormal` distinguishes a clean session end from a crash/disconnect.
   */
  sessionEnd?: { ts: string; abnormal: boolean };
}

/** True iff a descendant is a tool_error against the decision (early-close). */
function hasToolError(descendants: SonderEventLike[]): boolean {
  return descendants.some(
    (e) =>
      e.outcome !== undefined &&
      (e.outcome.isError ||
        (e.outcome.exit_code !== undefined && e.outcome.exit_code !== 0)),
  );
}

/** True iff a descendant is a human veto/undo (early-close). */
function hasHumanVeto(descendants: SonderEventLike[]): boolean {
  return descendants.some((e) => {
    const kind = e.metadata?.['kind'];
    return kind === 'veto' || kind === 'undo' || kind === 'user_correction';
  });
}

/**
 * Decide whether a pending row's window has closed, and why. First match in
 * priority order: early-close (definitive answer) → next-user-turn (seam) →
 * end-of-session → wall-clock cap.
 */
export function evaluateWindowClose(
  input: WindowCloseInput,
): WindowCloseDecision {
  const { row, descendants } = input;
  const now = input.now ?? new Date().toISOString();

  // 1. Early-close shortcuts — definitive answer, stop the clock immediately.
  if (hasHumanVeto(descendants) || hasToolError(descendants)) {
    return { closed: true, reason: 'early_close', closedAt: now };
  }

  // 2. SEAM (open-item #1): next user turn, once Sonder emits turn events.
  if (
    input.nextUserTurnTs !== undefined &&
    input.nextUserTurnTs <= row.windowDeadline
  ) {
    return {
      closed: true,
      reason: 'next_user_turn',
      closedAt: input.nextUserTurnTs,
    };
  }

  // 3. End-of-session inside the window.
  if (
    input.sessionEnd !== undefined &&
    input.sessionEnd.ts <= row.windowDeadline
  ) {
    return {
      closed: true,
      reason: 'end_of_session',
      closedAt: input.sessionEnd.ts,
      abnormalEnd: input.sessionEnd.abnormal,
    };
  }

  // 4. Wall-clock cap.
  if (now >= row.windowDeadline) {
    return { closed: true, reason: 'wall_clock', closedAt: row.windowDeadline };
  }

  return { closed: false };
}

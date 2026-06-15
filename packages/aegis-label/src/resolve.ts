/**
 * [C] Label resolver (scope §[C], label-spec §2). HIGHEST-RISK MODULE.
 *
 * On window close, scan the decision event's descendants and apply the §2
 * priority table FIRST-MATCH-WINS in this exact order:
 *
 *   1. human_veto      — descendant veto/undo/user-correction chaining to the
 *                        decision.
 *   2. tool_error      — outcome event isError===true OR
 *                        (exit_code != null && exit_code !== 0).
 *   3. downstream_error — descendant with error severity causally linked.
 *   4. rollback        — git revert/reset/restore or trash-restore on
 *                        OVERLAPPING resources[]/paths[] (normalized path-prefix
 *                        overlap).
 *
 *   else action_failed = 0.
 *
 * Abnormal session end inside the window → null (NEVER guess — Truth-above-all;
 * a missing label beats a fabricated one, label-spec §2).
 *
 * labelConfidence: 1.0 for veto/tool_error; 0.7 for downstream_error/rollback.
 * v1 ships hard 0/1 but records the confidence for v2 sample-weighting.
 */

import type {
  ChainReader,
  LabelResult,
  SonderEventLike,
} from './types.js';

/** Confidence per signal (label-spec §2.2). */
const CONFIDENCE = {
  human_veto: 1.0,
  tool_error: 1.0,
  downstream_error: 0.7,
  rollback: 0.7,
} as const;

export interface ResolveOptions {
  /** Cap on descendant-traversal depth (passed to queryDescendants). */
  maxDepth?: number;
  /**
   * The session ended abnormally (crash/disconnect) inside the window. When
   * true, the outcome is unknowable → label `null` (Truth-above-all).
   */
  abnormalSessionEnd?: boolean;
  /**
   * Only consider descendants at/before this ISO timestamp (the window close).
   * Defaults to no time bound (resolver is typically called once frozen).
   */
  windowCloseTs?: string;
}

/** Normalize a resource/path for prefix-overlap comparison. */
export function normalizePath(p: string): string {
  // Strip a trailing slash and collapse repeated slashes; keep it cheap and
  // deterministic. We do not resolve `..`/symlinks (the chain records literal
  // targets; over-normalizing would risk false overlaps).
  const collapsed = p.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/')
    ? collapsed.slice(0, -1)
    : collapsed;
}

/**
 * Normalized path-prefix overlap (scope §[C] open-item #4): two resource sets
 * overlap if any member of one is a path-prefix of any member of the other
 * (at a path-segment boundary), in either direction.
 */
export function resourcesOverlap(a: string[], b: string[]): boolean {
  const na = a.map(normalizePath);
  const nb = b.map(normalizePath);
  for (const x of na) {
    for (const y of nb) {
      if (x === y) return true;
      if (isPrefixPath(x, y) || isPrefixPath(y, x)) return true;
    }
  }
  return false;
}

/** True iff `prefix` is a path-prefix of `full` at a segment boundary. */
function isPrefixPath(prefix: string, full: string): boolean {
  if (prefix.length === 0 || full.length === 0) return false;
  if (!full.startsWith(prefix)) return false;
  if (full.length === prefix.length) return true;
  return full[prefix.length] === '/';
}

function resourcesOf(event: SonderEventLike): string[] {
  return [...(event.resources ?? []), ...(event.paths ?? [])];
}

function isToolError(event: SonderEventLike): boolean {
  const o = event.outcome;
  if (o === undefined) return false;
  return o.isError || (o.exit_code !== undefined && o.exit_code !== 0);
}

function isHumanVeto(event: SonderEventLike): boolean {
  const kind = event.metadata?.['kind'];
  return kind === 'veto' || kind === 'undo' || kind === 'user_correction';
}

function isDownstreamError(event: SonderEventLike): boolean {
  // An error-severity event causally linked within the window. Tool-error
  // outcome events are handled by signal #2; here we look at severity-tagged
  // events (the "write succeeded but broke the next build" class).
  const severity = event.metadata?.['severity'];
  return severity === 'error';
}

const ROLLBACK_RE =
  /\b(git\s+(revert|reset|restore|checkout\s+--)|restore[-_]?from[-_]?trash|trash[-_]?restore|rollback|undo)\b/i;

function isRollbackAction(event: SonderEventLike): boolean {
  const kind = event.metadata?.['kind'];
  if (kind === 'rollback') return true;
  // Fall back to inspecting the recorded command on the event metadata, when
  // the hook stamps it. We never re-parse arbitrary payload.
  const cmd = event.metadata?.['command'];
  return typeof cmd === 'string' && ROLLBACK_RE.test(cmd);
}

/**
 * Resolve the failure label for a decision event over its (closed) window.
 *
 * @param decisionEventId  the decision event whose fate we resolve
 * @param reader           audit-chain reader port
 * @param decisionResources  resources/paths the decision action touched
 *                           (for rollback-overlap). Pass from the decision event.
 * @param opts             traversal + abnormal-end controls
 */
export function resolveLabel(
  decisionEventId: string,
  reader: ChainReader,
  decisionResources: string[],
  opts: ResolveOptions = {},
): LabelResult {
  // Truth-above-all: an abnormal end inside the window means the outcome is
  // unknowable. Never guess — exclude the row from training.
  if (opts.abnormalSessionEnd === true) {
    return { action_failed: null, labelReason: null, labelConfidence: null };
  }

  // exactOptionalPropertyTypes: only pass maxDepth when actually set.
  let descendants = reader.queryDescendants(
    decisionEventId,
    opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {},
  );

  if (opts.windowCloseTs !== undefined) {
    const bound = opts.windowCloseTs;
    descendants = descendants.filter((e) => e.timestamp <= bound);
  }

  // §2 priority table — FIRST MATCH WINS, evaluated in strict order.

  // 1. human_veto
  if (descendants.some(isHumanVeto)) {
    return {
      action_failed: 1,
      labelReason: 'human_veto',
      labelConfidence: CONFIDENCE.human_veto,
    };
  }

  // 2. tool_error
  if (descendants.some(isToolError)) {
    return {
      action_failed: 1,
      labelReason: 'tool_error',
      labelConfidence: CONFIDENCE.tool_error,
    };
  }

  // 3. downstream_error (causally linked — descendants are by construction)
  if (descendants.some(isDownstreamError)) {
    return {
      action_failed: 1,
      labelReason: 'downstream_error',
      labelConfidence: CONFIDENCE.downstream_error,
    };
  }

  // 4. rollback on OVERLAPPING resources
  const rollback = descendants.some(
    (e) =>
      isRollbackAction(e) && resourcesOverlap(decisionResources, resourcesOf(e)),
  );
  if (rollback) {
    return {
      action_failed: 1,
      labelReason: 'rollback',
      labelConfidence: CONFIDENCE.rollback,
    };
  }

  // No signal fired → success.
  return { action_failed: 0, labelReason: null, labelConfidence: null };
}

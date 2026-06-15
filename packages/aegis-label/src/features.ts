/**
 * [D] Feature assembler (scope §[D], label-spec §5).
 *
 * Builds the frozen feature row from events AT/BEFORE the decision only.
 * Command-shape features come from the decision event's attached Aegis rule-eval
 * output (`metadata.aegis`) — we do NOT re-parse the command. Engram priors are
 * queried as-of `signalDate` via a port, never "now".
 *
 * CRITICAL leak guard: extraction hard-throws if any feature's source timestamp
 * is strictly after the decision event's timestamp (label-spec §5).
 */

import type {
  AegisDecisionMeta,
  FeatureRow,
  PriorSource,
  SessionHealthRegime,
  SonderEventLike,
} from './types.js';

/** Thrown when a feature would draw from an event after the decision (leak). */
export class FeatureLeakError extends Error {
  constructor(
    public readonly decisionEventId: string,
    public readonly offendingTimestamp: string,
    public readonly decisionTimestamp: string,
  ) {
    super(
      `Feature leak: source event @ ${offendingTimestamp} is after decision ` +
        `${decisionEventId} @ ${decisionTimestamp}. Walk-forward violated.`,
    );
    this.name = 'FeatureLeakError';
  }
}

/** Thrown when the decision event lacks the Aegis rule-eval metadata. */
export class MissingDecisionMetaError extends Error {
  constructor(decisionEventId: string) {
    super(
      `Decision event ${decisionEventId} has no metadata.aegis rule-eval ` +
        `output; cannot assemble command-shape features without re-parsing.`,
    );
    this.name = 'MissingDecisionMetaError';
  }
}

/** Pull and validate the Aegis rule-eval block stamped by the hook. */
export function readDecisionMeta(event: SonderEventLike): AegisDecisionMeta {
  const raw = event.metadata?.['aegis'];
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    throw new MissingDecisionMetaError(event.id);
  }
  // Structural narrowing: the hook owns this shape; we trust its presence but
  // never widen with `as any`.
  return raw as AegisDecisionMeta;
}

/** ISO timestamp → YYYY-MM-DD (the walk-forward signalDate key). */
export function signalDateOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/**
 * Compute `sessionHealthRegime` from rolling in-session outcome counters
 * (label-spec §6). Inputs are the prior actions' outcomes in this session,
 * oldest→newest, restricted by the caller to events at/before the decision.
 *
 * - thrashing: ≥2 failures in the last `windowN` actions (the "stop digging"
 *   valve, label-spec §6).
 * - recovering: exactly 1 recent failure in the window (a stumble; whether or not
 *   it was the most recent action, a single failure is mild tightening, not the
 *   hard thrash valve — that needs ≥2).
 * - clean: no failures in the window.
 */
export function computeRegime(
  recentOutcomes: boolean[],
  windowN = 5,
): SessionHealthRegime {
  if (recentOutcomes.length === 0) return 'clean';
  const window = recentOutcomes.slice(-windowN);
  const failures = window.filter((failed) => failed).length;
  if (failures >= 2) return 'thrashing';
  if (failures === 1) return 'recovering';
  return 'clean';
}

/** Longest path-prefix shared across touched paths (for the Engram prior key). */
function pathPrefixOf(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) return paths[0]!;
  let prefix = paths[0]!;
  for (const p of paths.slice(1)) {
    while (!p.startsWith(prefix) && prefix.length > 0) {
      const slash = prefix.lastIndexOf('/');
      prefix = slash > 0 ? prefix.slice(0, slash) : '';
    }
    if (prefix.length === 0) break;
  }
  return prefix;
}

export interface AssembleFeaturesInput {
  decisionEvent: SonderEventLike;
  /**
   * In-session events at/before the decision (oldest→newest), used for
   * taskDepth, prior-failure counters and the regime. The decision event itself
   * may be included; future events MUST NOT be (we assert it anyway).
   */
  priorEvents: SonderEventLike[];
  priors: PriorSource;
}

/**
 * Assemble the frozen feature row. Hard-throws on any leak.
 */
export function assembleFeatures(input: AssembleFeaturesInput): FeatureRow {
  const { decisionEvent, priorEvents, priors } = input;
  const decisionTs = decisionEvent.timestamp;
  const meta = readDecisionMeta(decisionEvent);

  // Leak guard: nothing we read may be timestamped after the decision.
  for (const e of priorEvents) {
    if (e.timestamp > decisionTs) {
      throw new FeatureLeakError(decisionEvent.id, e.timestamp, decisionTs);
    }
  }

  const signalDate = signalDateOf(decisionTs);
  const paths = decisionEvent.paths ?? decisionEvent.resources ?? [];
  const pathPrefix = pathPrefixOf(paths);

  // Prior in-session failures (outcome events before the decision), oldest→newest.
  const outcomes: boolean[] = [];
  let priorFailures = 0;
  for (const e of priorEvents) {
    if (e.id === decisionEvent.id) continue;
    if (e.outcome) {
      const failed =
        e.outcome.isError ||
        (e.outcome.exit_code !== undefined && e.outcome.exit_code !== 0);
      outcomes.push(failed);
      if (failed) priorFailures += 1;
    }
  }

  // taskDepth = parent_id chain length up to (and excluding) the decision.
  const byId = new Map(priorEvents.map((e) => [e.id, e] as const));
  let depth = 0;
  let cursor: SonderEventLike | undefined = decisionEvent;
  const seen = new Set<string>();
  while (cursor?.parent_id && !seen.has(cursor.parent_id)) {
    seen.add(cursor.parent_id);
    depth += 1;
    cursor = byId.get(cursor.parent_id);
  }

  // As-of prior — queried as-of signalDate, never "now".
  const prior = priors.lookup({
    tool: meta.tool,
    pathPrefix,
    asOf: signalDate,
  });

  return {
    decisionEventId: decisionEvent.id,
    signalDate,
    tool: meta.tool,
    ruleSeverityMax: meta.ruleSeverityMax,
    ruleCategoriesHit: meta.ruleCategoriesHit,
    ruleIdsHit: meta.ruleIdsHit,
    cmdLength: meta.cmdLength,
    combinatorCount: meta.combinatorCount,
    pathsTouched: meta.pathsTouched,
    writesVsReads: meta.writesVsReads,
    touchesGit: meta.touchesGit,
    touchesSystemDir: meta.touchesSystemDir,
    newFile: meta.newFile,
    agentId: decisionEvent.agent_id,
    taskDepth: depth,
    priorFailuresThisSession: priorFailures,
    sessionHealthRegime: computeRegime(outcomes),
    histFailRate_toolPath: prior.histFailRate_toolPath,
    secsSinceLastFailHere: prior.secsSinceLastFailHere,
    engramPriorN: prior.engramPriorN,
  };
}

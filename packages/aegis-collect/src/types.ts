/**
 * aegis-collect types.
 *
 * Three JSONL schemas live on disk:
 *   ~/.aegis/decisions.jsonl  — one row per PreToolUse decision (written by hook)
 *   ~/.aegis/outcomes.jsonl   — one row per PostToolUse result (written by outcome CLI)
 *   ~/.aegis/dataset-live.jsonl — joined rows ready for AWM refit
 *
 * Join key and reliability: see JOIN_KEY_NOTE below.
 */

import type { GateAction, Severity } from '@heybeaux/lattice-aegis';

export type { GateAction, Severity };

/**
 * JOIN KEY RELIABILITY NOTE
 * ─────────────────────────
 * Claude Code provides NO stable correlation id between a PreToolUse hook
 * invocation and the corresponding PostToolUse event. Both hooks receive
 * `tool_name` (and `tool_use_id` on PostToolUse payloads when present), so:
 *
 *   - BEST CASE (tool_use_id present on both): exact join on (tool_use_id).
 *     Reliability: exact, as long as the same tool_use_id appears in PostToolUse.
 *
 *   - FALLBACK (no shared id): fuzzy join on (tool, timestamp within ±5 s window).
 *     For the typical case of sequential tool calls this is usually unambiguous.
 *     Reliability: high for sequential flows, AMBIGUOUS under heavy parallelism
 *     (e.g. multiple Bash calls within 5 s). When the join is ambiguous,
 *     action_failed is set to null rather than guessing.
 *
 * The build-dataset script documents which join key was used per row via
 * `joinMethod: 'exact' | 'fuzzy' | 'none'` and only trusts exact joins by
 * default (TRUST_FUZZY_JOIN env flag can opt in to fuzzy).
 */
export const JOIN_KEY_NOTE =
  'Join key: tool_use_id (exact) or (tool, timestamp ±5s) (fuzzy). ' +
  'Fuzzy joins may be ambiguous under parallelism; action_failed = null when ambiguous.';

/** One PreToolUse decision captured before the hook exits. */
export interface DecisionRow {
  /** Monotonic: ISO-8601 UTC timestamp at recording time. */
  timestamp: string;
  /** Stable id: `${timestamp}_${tool}_${hash6}` where hash6 is a 6-char sha256 prefix of JSON(call). */
  decisionId: string;
  /**
   * tool_use_id from the Claude Code hook payload, when present.
   * Used as the primary join key with outcomes.
   */
  toolUseId?: string;
  /** The tool that was called (e.g. "Bash", "Write", "Read"). */
  tool: string;
  /** The gate decision. */
  action: GateAction;
  /** Highest severity rule that matched; 'none' if nothing fired. */
  ruleSeverityMax: Severity | 'none';
  /** Distinct rule categories that fired. */
  ruleCategoriesHit: string[];
  /** Rule ids that fired. */
  ruleIdsHit: string[];
  /** Assembled command length in characters (0 if no command). */
  cmdLength: number;
  /** Count of shell combinators (;  &&  ||  |  $()  ` >  <). */
  combinatorCount: number;
  /** Number of distinct paths the action touches. */
  pathsTouched: number;
  /** Read/write classification. */
  writesVsReads: 'read' | 'write' | 'mixed' | 'none';
  /** Whether the action touches a git resource. */
  touchesGit: boolean;
  /** Whether the action touches a system directory (/etc, /usr, /bin, /sbin, /lib). */
  touchesSystemDir: boolean;
  /** Whether the action creates a new file (Write tool with no prior read). */
  newFile: boolean;
  /** P(failure) from AWM prediction if present; undefined when no predictor running. */
  pFailure?: number;
}

/** One PostToolUse/PostToolUseFailure outcome recorded by the outcome CLI. */
export interface OutcomeRow {
  /** ISO-8601 UTC timestamp at recording time. */
  timestamp: string;
  /** tool_name from the Claude Code hook payload. */
  tool: string;
  /**
   * tool_use_id from the Claude Code hook payload, when present.
   * Used as the primary join key with decisions.
   */
  toolUseId?: string;
  /** Process exit code if available; undefined when absent. */
  exitCode?: number;
  /** True when the tool reported an error. */
  isError: boolean;
  /** Error string if available. */
  error?: string;
}

/** A joined row ready for AWM training. */
export interface DatasetRow {
  /** Source decision row id. */
  decisionId: string;
  /** Source outcome row timestamp (the matched outcome). */
  outcomeTimestamp?: string;
  /** All decision-side features. */
  decision: DecisionRow;
  /**
   * 1 = tool call failed, 0 = succeeded, null = outcome unknown (unjoinable
   * or ambiguous fuzzy match). Truth-above-all: never guess.
   */
  action_failed: 0 | 1 | null;
  /** How the join was made. */
  joinMethod: 'exact' | 'fuzzy' | 'none';
}

/**
 * Command-shape feature derivation from a ToolCall + Evaluation.
 *
 * These helpers derive the AegisDecisionMeta-compatible fields from the
 * raw ToolCall and Evaluation that the hook already has in memory — zero
 * re-parsing. All functions are pure and synchronous.
 */

import type { Evaluation, RuleHit, Severity, ToolCall } from '@heybeaux/lattice-aegis';
import type { DecisionRow } from './types.js';

/** Shell combinators we count in command strings. */
const COMBINATOR_RE = /;|&&|\|\||[|`]|\$\(|>>?|</g;

/** Paths that indicate git operations. */
const GIT_PATH_RE = /\/\.git\b|^\.git\b/;
const GIT_CMD_RE = /\bgit\b/;

/** System directories that indicate system-level access. */
const SYSTEM_DIR_RE = /^\/(?:etc|usr|bin|sbin|lib|lib64|proc|sys|dev)\b/;

/** Derive combinatorCount from a command string. */
export function countCombinators(cmd: string): number {
  return (cmd.match(COMBINATOR_RE) ?? []).length;
}

/** Determine writes-vs-reads classification from tool and presence of content/paths. */
export function classifyWritesVsReads(
  call: ToolCall,
): DecisionRow['writesVsReads'] {
  const tool = call.tool.toLowerCase();
  if (tool === 'read') return 'read';
  if (tool === 'write' || tool === 'edit' || tool === 'multiedit') return 'write';
  if (tool === 'bash') {
    // If command has write indicators, classify as write; otherwise mixed.
    const cmd = call.command ?? '';
    const hasWrite = /\b(?:rm|mv|cp|mkdir|touch|chmod|chown|echo\s.*>|tee|sed\s+-i|awk.*>)\b|>>?/.test(cmd);
    const hasRead = /\b(?:cat|less|head|tail|grep|find|ls|wc|diff|awk|sed)\b/.test(cmd);
    if (hasWrite && !hasRead) return 'write';
    if (!hasWrite && hasRead) return 'read';
    if (hasWrite || hasRead) return 'mixed';
    return 'none';
  }
  if (call.content !== undefined) return 'write';
  if (call.paths && call.paths.length > 0) return 'read';
  return 'none';
}

/** Detect git operations in command or paths. */
export function detectGit(call: ToolCall): boolean {
  if (call.command && GIT_CMD_RE.test(call.command)) return true;
  if (call.paths?.some((p) => GIT_PATH_RE.test(p))) return true;
  return false;
}

/** Detect system directory access in paths or command. */
export function detectSystemDir(call: ToolCall): boolean {
  if (call.paths?.some((p) => SYSTEM_DIR_RE.test(p))) return true;
  if (call.command && SYSTEM_DIR_RE.test(call.command)) return true;
  return false;
}

/** Derive ruleSeverityMax from the list of rule hits. */
export function maxSeverity(matches: RuleHit[]): Severity | 'none' {
  if (matches.length === 0) return 'none';
  const order: Record<Severity, number> = {
    critical: 3,
    high: 2,
    medium: 1,
    low: 0,
  };
  let max: Severity = 'low';
  for (const hit of matches) {
    if (order[hit.severity] > order[max]) max = hit.severity;
  }
  return max;
}

/**
 * Derive the command-shape fields from a ToolCall and Evaluation.
 * Does NOT include identity fields (decisionId, timestamp, toolUseId, action).
 */
export function deriveShapeFields(
  call: ToolCall,
  evaluation: Evaluation,
): Pick<
  DecisionRow,
  | 'tool'
  | 'ruleSeverityMax'
  | 'ruleCategoriesHit'
  | 'ruleIdsHit'
  | 'cmdLength'
  | 'combinatorCount'
  | 'pathsTouched'
  | 'writesVsReads'
  | 'touchesGit'
  | 'touchesSystemDir'
  | 'newFile'
  | 'pFailure'
> {
  const cmd = call.command ?? '';
  return {
    tool: call.tool,
    ruleSeverityMax: maxSeverity(evaluation.matches),
    ruleCategoriesHit: [...new Set(evaluation.matches.map((m) => m.category))],
    ruleIdsHit: evaluation.matches.map((m) => m.id),
    cmdLength: cmd.length,
    combinatorCount: countCombinators(cmd),
    pathsTouched: call.paths?.length ?? 0,
    writesVsReads: classifyWritesVsReads(call),
    touchesGit: detectGit(call),
    touchesSystemDir: detectSystemDir(call),
    newFile: call.tool === 'Write',
    pFailure: evaluation.prediction?.pFailure,
  };
}

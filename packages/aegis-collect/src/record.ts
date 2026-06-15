/**
 * recordDecision — append one DecisionRow to ~/.aegis/decisions.jsonl.
 *
 * FAIL-OPEN: any error (dir missing, disk full, permissions) is swallowed.
 * A logging fault MUST NOT change the hook's exit code. The hook wraps this in
 * its own try/catch too, but we guarantee it here regardless.
 *
 * FAST: append-only, no network, no DB. The only I/O is mkdirSync + appendFileSync.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Evaluation, ToolCall } from '@heybeaux/lattice-aegis';
import type { DecisionRow } from './types.js';
import { deriveShapeFields } from './shapes.js';

/** Default directory for aegis-collect data files. */
function collectDir(): string {
  return process.env['AEGIS_COLLECT_DIR'] ?? join(homedir(), '.aegis');
}

/** Stable 6-char hash prefix of the serialised call object. */
function shortHash(call: ToolCall): string {
  const json = JSON.stringify({ tool: call.tool, cmd: call.command, paths: call.paths });
  return createHash('sha256').update(json).digest('hex').slice(0, 6);
}

/** Build a stable decisionId: `${isoTs}_${tool}_${hash6}`. */
function makeDecisionId(timestamp: string, call: ToolCall): string {
  // Sanitise tool name for fs-safe use in the id.
  const safeTool = call.tool.replace(/[^a-zA-Z0-9]/g, '_');
  return `${timestamp}_${safeTool}_${shortHash(call)}`;
}

/**
 * Append one decision row to the JSONL log. Fail-open.
 *
 * @param call        - The ToolCall passed to the evaluator.
 * @param evaluation  - The Evaluation returned by evaluate().
 * @param toolUseId   - Optional tool_use_id from Claude Code's hook payload
 *                      (primary join key with outcomes).
 */
export function recordDecision(
  call: ToolCall,
  evaluation: Evaluation,
  toolUseId?: string,
): void {
  try {
    const dir = collectDir();
    mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString();
    const decisionId = makeDecisionId(timestamp, call);
    const shape = deriveShapeFields(call, evaluation);

    const row: DecisionRow = {
      timestamp,
      decisionId,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      ...shape,
      action: evaluation.action,
    };

    appendFileSync(join(dir, 'decisions.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  } catch {
    // Intentionally swallowed — fail-open; see module docstring.
  }
}

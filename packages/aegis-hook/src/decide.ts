/**
 * Map an Aegis {@link Evaluation} to the Claude Code PreToolUse exit contract.
 *
 * Claude Code reads the hook's exit code:
 *   - exit 0 -> ALLOW; the tool call proceeds.
 *   - exit 2 -> BLOCK; whatever is on stderr is surfaced to the model as the reason.
 *
 * Aegis returns three gate actions:
 *   - 'deny'  -> exit 2, reason on stderr.
 *   - 'ask'   -> exit 0, advisory on stderr. Claude Code PreToolUse has no native
 *                "ask"; `ask` therefore DEGRADES to allow-with-warning under the
 *                current hook protocol — a known limitation, not a bug. The advisory
 *                is still printed so the human/model sees it.
 *   - 'allow' -> exit 0, empty stderr.
 */

import type { Evaluation } from '@heybeaux/lattice-aegis';

export interface Decision {
  /** Process exit code: 2 blocks, 0 allows. */
  exitCode: 0 | 2;
  /** Text to write to stderr (model-visible; '' when allowing silently). */
  stderr: string;
}

/** Pure mapping from an Aegis evaluation to an exit code + stderr payload. */
export function decide(evaluation: Evaluation): Decision {
  switch (evaluation.action) {
    case 'deny':
      return { exitCode: 2, stderr: `[Aegis DENY] ${evaluation.reason}` };
    case 'ask':
      // No native "ask" in PreToolUse — degrade to allow-with-warning.
      return { exitCode: 0, stderr: `[Aegis ASK] ${evaluation.reason}` };
    case 'allow':
    default:
      return { exitCode: 0, stderr: '' };
  }
}

#!/usr/bin/env node
/**
 * aegis-outcome — PostToolUse / PostToolUseFailure hook CLI.
 *
 * Claude Code pipes a JSON payload to stdin on every PostToolUse event:
 *
 *   {
 *     "tool_name": "Bash",
 *     "tool_use_id": "toolu_abc123",     // present when Claude Code >= certain version
 *     "tool_input": { "command": "..." },
 *     "tool_response": {
 *       "output": "...",
 *       "error": "...",          // on failure
 *       "isError": true          // on failure
 *     }
 *   }
 *
 * On PostToolUseFailure the envelope is the same but tool_response.isError is
 * always true. `exit_code` is NOT in the Claude Code PostToolUse payload — the
 * hook sees tool success/failure, not process exit codes. We record what we can.
 *
 * FAIL-OPEN: any fault is swallowed; exit 0 always (a broken hook must not
 * abort the session).
 *
 * JOIN KEY: tool_use_id (when present) is the primary join key. When absent
 * (older Claude Code versions), the build-dataset script falls back to
 * (tool, timestamp ±5 s). See JOIN_KEY_NOTE in types.ts.
 */

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OutcomeRow } from './types.js';

function collectDir(): string {
  return process.env['AEGIS_COLLECT_DIR'] ?? join(homedir(), '.aegis');
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function bool(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] === true;
}

function runOutcome(): void {
  let raw: unknown;
  try {
    const input = readFileSync(0, 'utf8').trim();
    if (input === '') return;
    raw = JSON.parse(input);
  } catch {
    return; // Fail open — unparseable stdin.
  }

  try {
    const root = asRecord(raw);
    const response = asRecord(root['tool_response']);

    const tool = str(root, 'tool_name') ?? '';
    const toolUseId = str(root, 'tool_use_id');

    // isError: true when PostToolUseFailure or when tool_response.isError is set.
    const isError = bool(response, 'isError');
    const error = str(response, 'error') ?? str(response, 'stderr');

    // Claude Code does not expose raw exit codes in hook payloads.
    // exitCode is intentionally omitted (undefined) — do not fabricate.

    const row: OutcomeRow = {
      timestamp: new Date().toISOString(),
      tool,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      isError,
      ...(error !== undefined ? { error } : {}),
    };

    const dir = collectDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'outcomes.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  } catch {
    // Fail open.
  }
}

try {
  runOutcome();
} catch {
  // Outermost guard — always exit 0.
}
process.exit(0);

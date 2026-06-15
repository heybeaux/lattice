/**
 * Read Claude Code's PreToolUse stdin and map it to an Aegis {@link ToolCall}.
 *
 * Claude Code pipes JSON to the hook's stdin shaped like:
 *   Bash:  { "tool_name": "Bash",  "tool_input": { "command": "rm -rf /" } }
 *   Write: { "tool_name": "Write", "tool_input": { "file_path": "/x", "content": "..." } }
 *   Edit:  { "tool_name": "Edit",  "tool_input": { "file_path": "/x", "new_string": "..." } }
 *   Read:  { "tool_name": "Read",  "tool_input": { "file_path": "/x" } }
 *
 * The mapping is intentionally defensive: any unknown tool / shape produces a
 * best-effort ToolCall from whatever fields exist, never a throw. The hook fails
 * OPEN, so a malformed payload becomes a near-empty ToolCall that matches nothing.
 */

import { readFileSync } from 'node:fs';
import type { ToolCall } from '@heybeaux/lattice-aegis';

/** Narrow an unknown value to a plain (non-array, non-null) object. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Pull a string field if present and actually a string. */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Pure mapping from a raw Claude Code hook payload to an Aegis ToolCall.
 *
 * - `tool_name` -> `tool` (empty string when absent).
 * - `tool_input.command` -> `command` (Bash).
 * - `tool_input.content` (Write) or `new_string` (Edit) -> `content`.
 * - `tool_input.file_path` (Write/Edit/Read) -> `paths: [...]`.
 *
 * No throws — safe to unit test in isolation.
 */
export function toToolCall(hookInput: unknown): ToolCall {
  const root = asRecord(hookInput);
  const input = asRecord(root.tool_input);

  const tool = str(root, 'tool_name') ?? '';

  const command = str(input, 'command');
  // Write ships `content`; Edit ships `new_string`. Prefer `content`, fall back to
  // the edit payload so file-content rules still see what is being written.
  const content = str(input, 'content') ?? str(input, 'new_string');

  const paths: string[] = [];
  const filePath = str(input, 'file_path');
  if (filePath) paths.push(filePath);

  const call: ToolCall = { tool };
  if (command !== undefined) call.command = command;
  if (content !== undefined) call.content = content;
  if (paths.length > 0) call.paths = paths;
  return call;
}

/** Read all of stdin synchronously (fd 0). Returns '' when nothing is piped. */
export function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    // No piped stdin (e.g. invoked interactively) — treat as empty.
    return '';
  }
}

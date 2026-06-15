/**
 * Builders for the Claude Code settings.json PreToolUse hook fragment.
 *
 * THE WHOLE POINT: emit the CORRECT nested schema. Claude Code wants
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "Bash|Write|Edit|Read",
 *           "hooks": [ { "type": "command", "command": "<bin>" } ] }
 *       ]
 *     }
 *   }
 *
 * `PreToolUse` is an ARRAY of `{ matcher, hooks }`, and `hooks` is itself an array
 * of `{ type:"command", command }`. AutoHarness shipped a flat `{ type, command }`
 * list at the top level — wrong schema, so its hook never fired. These helpers are
 * pure (no file I/O); the real install command lives elsewhere and writes carefully.
 */

/** A single command hook entry. */
export interface CommandHook {
  type: 'command';
  command: string;
}

/** One PreToolUse matcher entry: a tool-name regex + its command hooks. */
export interface MatcherEntry {
  matcher: string;
  hooks: CommandHook[];
}

/** The hook fragment shape — a partial settings.json. */
export interface HookConfig {
  hooks: {
    PreToolUse: MatcherEntry[];
  };
}

/** A settings.json object: arbitrary keys, plus an optional hooks map. */
export interface Settings {
  hooks?: {
    PreToolUse?: MatcherEntry[];
    [event: string]: MatcherEntry[] | undefined;
  };
  [key: string]: unknown;
}

/** Default matcher: the four tools Aegis governs. */
const DEFAULT_MATCHER = 'Bash|Write|Edit|Read';

/**
 * Build the correct nested PreToolUse hook fragment for settings.json.
 * `command` is the full shell command Claude Code runs (e.g. `node /abs/dist/cli.js`).
 */
export function buildHookConfig(opts: { command: string; matcher?: string }): HookConfig {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: opts.matcher ?? DEFAULT_MATCHER,
          hooks: [{ type: 'command', command: opts.command }],
        },
      ],
    },
  };
}

/**
 * Merge a hook fragment's PreToolUse entries into an existing settings object
 * WITHOUT clobbering other hooks or other top-level keys. Appends to the existing
 * PreToolUse array if present, creates it otherwise. Returns a new object (the
 * inputs are not mutated).
 */
export function mergeIntoSettings(existing: Settings, fragment: HookConfig): Settings {
  const merged: Settings = { ...existing, hooks: { ...existing.hooks } };
  const incoming = fragment.hooks.PreToolUse;
  const current = merged.hooks?.PreToolUse ?? [];
  merged.hooks = { ...merged.hooks, PreToolUse: [...current, ...incoming] };
  return merged;
}

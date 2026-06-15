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
 * list at the top level — wrong schema, so its hook never fired. The builder /
 * merge helpers are pure (no file I/O); {@link installHook} is the one function
 * that touches disk, and it merges + writes carefully (read → merge → atomic write).
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

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
  // Idempotency: skip any incoming entry whose command already appears in a
  // PreToolUse hook. Re-running install must not stack duplicate Aegis matchers
  // (and must never touch the other tools' matchers — claude-flow etc.).
  const existingCommands = new Set(
    current.flatMap((entry) => entry.hooks.map((h) => h.command)),
  );
  const toAdd = incoming.filter(
    (entry) => !entry.hooks.every((h) => existingCommands.has(h.command)),
  );
  merged.hooks = { ...merged.hooks, PreToolUse: [...current, ...toAdd] };
  return merged;
}

/** Result of an {@link installHook} run. */
export interface InstallResult {
  /** The settings.json path written. */
  settingsPath: string;
  /** Path of the timestamped backup taken before writing (when the file existed). */
  backupPath?: string;
  /** True when our matcher was newly added; false when it was already present. */
  added: boolean;
  /** The PreToolUse matcher entries after the merge (for verification). */
  preToolUse: MatcherEntry[];
}

/**
 * Install the Aegis hook into a settings.json on disk: read the existing file
 * (treating a missing file as `{}`), MERGE our matcher in without clobbering any
 * other hooks or top-level keys, back the original up, and write the result.
 *
 * The write is the careful part the README promises:
 *  - a timestamped `.bak-aegis-<ms>` copy is taken before any write (when the
 *    file already exists), so a bad merge is always recoverable;
 *  - JSON is round-tripped (parse → merge → 2-space stringify), so an unparseable
 *    settings file throws BEFORE we touch anything rather than corrupting it.
 */
export function installHook(opts: {
  settingsPath: string;
  /** The full command Claude Code runs for the hook (e.g. `node /abs/dist/cli.js`). */
  command: string;
  matcher?: string;
}): InstallResult {
  const { settingsPath, command, matcher } = opts;

  let existing: Settings = {};
  let fileExisted = false;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    fileExisted = true;
    existing = JSON.parse(raw) as Settings;
  } catch (err) {
    // ENOENT → fresh install ({}). Any OTHER error (parse failure, EACCES) must
    // surface — we will NOT overwrite a settings file we could not read.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `aegis-hook install: refusing to write — could not read existing ` +
          `${settingsPath}: ${(err as Error).message}`,
      );
    }
  }

  const before = existing.hooks?.PreToolUse ?? [];
  const fragment = buildHookConfig(matcher !== undefined ? { command, matcher } : { command });
  const merged = mergeIntoSettings(existing, fragment);
  const after = merged.hooks?.PreToolUse ?? [];
  const added = after.length > before.length;

  const result: InstallResult = { settingsPath, added, preToolUse: after };

  // Back up the original before writing (recoverable beats gone forever).
  if (fileExisted) {
    const backupPath = `${settingsPath}.bak-aegis-${Date.now()}`;
    copyFileSync(settingsPath, backupPath);
    result.backupPath = backupPath;
  }

  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return result;
}

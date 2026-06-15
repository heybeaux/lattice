/**
 * @heybeaux/aegis-hook — Claude Code PreToolUse hook for the Aegis governance engine.
 *
 * Re-exports the pure, programmatically-useful pieces for testing and embedding.
 * The runnable hook entry is `cli.ts` (bin `aegis-hook`).
 *
 * @packageDocumentation
 */

export { toToolCall, readStdin } from './stdin.js';
export { loadAllPacks } from './rules.js';
export { decide, type Decision } from './decide.js';
export {
  buildHookConfig,
  mergeIntoSettings,
  installHook,
  type HookConfig,
  type MatcherEntry,
  type CommandHook,
  type Settings,
  type InstallResult,
} from './install.js';

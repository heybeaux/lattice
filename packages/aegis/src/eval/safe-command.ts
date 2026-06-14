/**
 * Combinator-aware safe-command allowlist. Ported from AutoHarness `_is_safe_command`
 * (core/risk.py) — the one piece of their engine logic worth taking verbatim.
 *
 * Refuses to fast-path ("safe") anything containing shell combinators, because a
 * combinator can smuggle a dangerous command past a naive allowlist. Uses word-boundary
 * matching so `catastrophe` is not treated as `cat`.
 */

/** Shell metacharacters/combinators that disqualify a command from the fast path. */
const COMBINATORS = [';', '&&', '||', '|', '$(', '`', '>', '<', '&'];

/** Conservative default allowlist of read-only-ish commands. Tunable via constitution. */
const DEFAULT_SAFE = new Set([
  'ls',
  'cat',
  'echo',
  'pwd',
  'whoami',
  'date',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  'which',
  'git',
]);

function hasCombinator(command: string): boolean {
  return COMBINATORS.some((c) => command.includes(c));
}

/**
 * True only if the command's leading token is allowlisted AND it contains no shell
 * combinators. Anything with a combinator is never fast-pathed.
 */
export function isSafeCommand(
  command: string,
  allowlist: ReadonlySet<string> = DEFAULT_SAFE,
): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (hasCombinator(trimmed)) return false;

  // Leading token, word-boundary aware (so `catastrophe` != `cat`).
  const match = /^(\S+)/.exec(trimmed);
  if (!match) return false;
  const head = match[1];

  return allowlist.has(head);
}

export { DEFAULT_SAFE };

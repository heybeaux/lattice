/**
 * Rule-pack loader: validate -> flag-restrict -> compile -> ReDoS budget.
 * Fail-closed: a pack that violates any guard is rejected wholesale, loudly.
 * See docs/aegis-rulepack-spec-2026-06-14.md §2.
 */

import type {
  AllowedFlag,
  CompiledRule,
  Rule,
  RulePack,
} from '../types.js';

const ALLOWED_FLAGS: ReadonlySet<string> = new Set<AllowedFlag>([
  'i',
  'm',
  's',
  'u',
]);

/** Adversarial filler strings used to detect catastrophic backtracking at load time. */
const REDOS_PROBES: readonly string[] = [
  'a'.repeat(64),
  ('a' + ' ').repeat(48),
  '/'.repeat(64),
  ('rm -rf ' + 'x'.repeat(8) + ' ').repeat(16),
  'aaaaaaaaaaaaaaaaaaaaaaaa!'.repeat(8),
];

/** Per-probe match budget. A pattern slower than this on any probe is rejected. */
const REDOS_BUDGET_MS = 5;

export class RulePackError extends Error {
  constructor(
    message: string,
    readonly packId: string,
    readonly ruleId?: string,
  ) {
    super(
      ruleId
        ? `[aegis:${packId}/${ruleId}] ${message}`
        : `[aegis:${packId}] ${message}`,
    );
    this.name = 'RulePackError';
  }
}

function validateFlags(flags: string | undefined, pack: RulePack, rule: Rule): void {
  if (!flags) return;
  for (const f of flags) {
    if (!ALLOWED_FLAGS.has(f)) {
      throw new RulePackError(
        `disallowed regex flag '${f}' (allowed: i,m,s,u; never g)`,
        pack.packId,
        rule.id,
      );
    }
  }
}

function compileRegex(pack: RulePack, rule: Rule): RegExp {
  const { pattern, flags } = rule.match;
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new RulePackError(
      `regex failed to compile: ${(err as Error).message}`,
      pack.packId,
      rule.id,
    );
  }
}

function assertNoReDoS(regex: RegExp, pack: RulePack, rule: Rule): void {
  for (const probe of REDOS_PROBES) {
    // Fresh regex each probe — defensive against any residual lastIndex.
    const r = new RegExp(regex.source, regex.flags);
    const start = performance.now();
    r.test(probe);
    const elapsed = performance.now() - start;
    if (elapsed > REDOS_BUDGET_MS) {
      throw new RulePackError(
        `pattern exceeded ReDoS budget (${elapsed.toFixed(1)}ms > ${REDOS_BUDGET_MS}ms) on a probe — likely catastrophic backtracking`,
        pack.packId,
        rule.id,
      );
    }
  }
}

function validateRuleShape(pack: RulePack, rule: Rule): void {
  if (!rule.id) throw new RulePackError('rule missing id', pack.packId);
  if (!rule.match?.pattern) {
    throw new RulePackError('rule missing match.pattern', pack.packId, rule.id);
  }
  if (!rule.appliesTo || rule.appliesTo.length === 0) {
    throw new RulePackError(
      'rule must declare appliesTo (use ["*"] for any tool)',
      pack.packId,
      rule.id,
    );
  }
}

/** Compile a single pack. Throws RulePackError on any guard violation. */
export function loadPack(pack: RulePack): CompiledRule[] {
  if (!pack.packId) throw new RulePackError('pack missing packId', '<unknown>');
  const seen = new Set<string>();
  const compiled: CompiledRule[] = [];

  for (const rule of pack.rules) {
    validateRuleShape(pack, rule);
    if (seen.has(rule.id)) {
      throw new RulePackError(`duplicate rule id within pack`, pack.packId, rule.id);
    }
    seen.add(rule.id);

    if (rule.match.kind === 'regex') {
      validateFlags(rule.match.flags, pack, rule);
      const regex = compileRegex(pack, rule);
      assertNoReDoS(regex, pack, rule);
      compiled.push({ rule, regex });
    } else if (rule.match.kind === 'substring') {
      compiled.push({ rule });
    } else {
      // ast — reserved for Phase 5.
      throw new RulePackError(
        `match.kind 'ast' not yet supported (Phase 5)`,
        pack.packId,
        rule.id,
      );
    }
  }

  return compiled;
}

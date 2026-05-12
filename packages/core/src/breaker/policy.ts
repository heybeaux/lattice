/**
 * L0 policy-rules engine. Pure + sync; no I/O, no `Date.now()`, no `Math.random()`.
 *
 * Two entry points:
 *
 * - {@link compilePolicyRuleSet} — validates a `PolicyRuleSet` per R9 (unique
 *   IDs, JSONPath parses, regex compiles, numeric ops valid, `custom`
 *   evaluate is a function) and pre-compiles all JSONPath accessors so
 *   evaluation is O(rule × path-depth). Construction-time validation is
 *   fast; the per-rule determinism fuzz lives in `test-helpers` and is
 *   CI-only (R9).
 *
 * - {@link evaluatePolicy} — runs the compiled rule set against a contract,
 *   producing one {@link PolicyEvidenceRow} per rule.
 *
 * Determinism (R5): identical inputs MUST produce identical evidence rows
 * (excluding `durationMs`, which is the caller's responsibility). The engine
 * never observes the clock, the RNG, or the network.
 *
 * Defensive default for unresolved JSONPaths:
 *   - `forbidden`            → pass (absence is the goal)
 *   - `required`             → fail with `'jsonpath did not resolve'`
 *   - all other rule kinds   → fail with `'jsonpath did not resolve'`
 *   - `denylist`, `regex-deny` → pass (no value, nothing to forbid)
 *
 * The denylist/regex-deny carve-out matches R4: "Resolves to `pass` when path
 * does not resolve." Allowlist, numeric-bound, custom, conditional fall under
 * the "fail-closed if we cannot evaluate" rule.
 */

import type { StateContract } from '../contract/types.js';
import { compileJSONPath, evaluateJSONPath, type CompiledJSONPath } from './jsonpath.js';
import type {
  ConditionalPredicate,
  PolicyEvidenceRow,
  PolicyRule,
  PolicyRuleKind,
  PolicyRuleSet,
} from './types.js';

/**
 * A `PolicyRule` rewritten with pre-compiled JSONPaths and (for `regex-deny`)
 * a pre-compiled `RegExp`. Cached per rule at `PolicyRuleSet` construction
 * so evaluation never re-parses anything.
 */
export type CompiledPolicyRule =
  | (PolicyRule & { kind: 'allowlist'; compiledPath: CompiledJSONPath })
  | (PolicyRule & { kind: 'denylist'; compiledPath: CompiledJSONPath })
  | (PolicyRule & {
      kind: 'regex-deny';
      compiledPath: CompiledJSONPath;
      compiledRegex: RegExp;
    })
  | (PolicyRule & { kind: 'numeric-bound'; compiledPath: CompiledJSONPath })
  | (PolicyRule & { kind: 'required'; compiledPath: CompiledJSONPath })
  | (PolicyRule & { kind: 'forbidden'; compiledPath: CompiledJSONPath })
  | (PolicyRule & {
      kind: 'conditional';
      compiledPath: CompiledJSONPath;
      compiledWhen: CompiledPredicate;
      compiledThen: CompiledPredicate;
    })
  | (PolicyRule & { kind: 'custom'; compiledPath: CompiledJSONPath });

/**
 * A {@link ConditionalPredicate} with its JSONPath pre-compiled. The
 * `matches` variant carries the literal `value` as-is; we do NOT precompile
 * regex from it (predicate is plain string equality per R4).
 */
export type CompiledPredicate =
  | { jsonpath: string; predicate: 'resolves'; compiledPath: CompiledJSONPath }
  | { jsonpath: string; predicate: 'is-truthy'; compiledPath: CompiledJSONPath }
  | { jsonpath: string; predicate: 'matches'; value: string; compiledPath: CompiledJSONPath };

/**
 * A `PolicyRuleSet` with every rule compiled. Construct with
 * {@link compilePolicyRuleSet}; this is the form the breaker stores.
 */
export interface CompiledPolicyRuleSet {
  id: string;
  version: string;
  rules: readonly CompiledPolicyRule[];
}

/**
 * Soft warning threshold per R10 — `PolicyRuleSet` construction with more
 * than 100 rules SHOULD emit a console warning. Construction does NOT refuse
 * large sets; it logs once and proceeds.
 */
const LARGE_RULESET_WARN_THRESHOLD = 100;

const NUMERIC_BOUND_OPS = new Set(['<=', '<', '>=', '>', '==']);

/**
 * Validate and compile a {@link PolicyRuleSet}. Throws on any R9 violation
 * with a message that names the offending rule ID where applicable.
 *
 * R9 checks (all synchronous, all runtime-path-only):
 *   - Rule IDs unique within the set.
 *   - Every JSONPath parses against the supported subset.
 *   - Every regex compiles.
 *   - `numeric-bound` ops are one of `<= < >= > ==`.
 *   - `custom` rules' `evaluate` is a function (typeof check only).
 *
 * Determinism fuzz is intentionally NOT run here — see R9 + the
 * `verifyCustomRuleDeterminism` helper in `@heybeaux/lattice-core/test-helpers`.
 *
 * @param set - The user-supplied {@link PolicyRuleSet}.
 * @returns A {@link CompiledPolicyRuleSet} suitable for repeated evaluation.
 */
export function compilePolicyRuleSet(set: PolicyRuleSet): CompiledPolicyRuleSet {
  if (!set || typeof set !== 'object') {
    throw new Error('PolicyRuleSet must be an object');
  }
  if (typeof set.id !== 'string' || set.id.length === 0) {
    throw new Error('PolicyRuleSet.id must be a non-empty string');
  }
  if (typeof set.version !== 'string' || set.version.length === 0) {
    throw new Error('PolicyRuleSet.version must be a non-empty string');
  }
  if (!Array.isArray(set.rules)) {
    throw new Error(`PolicyRuleSet '${set.id}': rules must be an array`);
  }

  const seenIds = new Set<string>();
  const compiled: CompiledPolicyRule[] = [];

  for (const rule of set.rules) {
    if (!rule || typeof rule !== 'object') {
      throw new Error(`PolicyRuleSet '${set.id}': rule must be an object`);
    }
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      throw new Error(`PolicyRuleSet '${set.id}': rule.id must be a non-empty string`);
    }
    if (seenIds.has(rule.id)) {
      throw new Error(`PolicyRuleSet '${set.id}': duplicate rule id '${rule.id}'`);
    }
    seenIds.add(rule.id);

    if (typeof rule.description !== 'string') {
      throw new Error(`PolicyRuleSet '${set.id}': rule '${rule.id}' missing description`);
    }
    if (typeof rule.jsonpath !== 'string') {
      throw new Error(`PolicyRuleSet '${set.id}': rule '${rule.id}' missing jsonpath`);
    }

    // Compile the rule's primary JSONPath. compileJSONPath throws with a
    // clear error message; we wrap it to surface the offending rule ID.
    let compiledPath: CompiledJSONPath;
    try {
      compiledPath = compileJSONPath(rule.jsonpath);
    } catch (err) {
      throw new Error(
        `PolicyRuleSet '${set.id}': rule '${rule.id}' has invalid jsonpath: ${(err as Error).message}`,
      );
    }

    switch (rule.kind) {
      case 'allowlist':
      case 'denylist': {
        if (!Array.isArray(rule.values)) {
          throw new Error(
            `PolicyRuleSet '${set.id}': rule '${rule.id}' (${rule.kind}) must define values: string[]`,
          );
        }
        compiled.push({ ...rule, compiledPath } as CompiledPolicyRule);
        break;
      }
      case 'regex-deny': {
        let compiledRegex: RegExp;
        try {
          compiledRegex = new RegExp(rule.pattern, rule.flags);
        } catch (err) {
          throw new Error(
            `PolicyRuleSet '${set.id}': rule '${rule.id}' has invalid regex: ${(err as Error).message}`,
          );
        }
        compiled.push({ ...rule, compiledPath, compiledRegex } as CompiledPolicyRule);
        break;
      }
      case 'numeric-bound': {
        if (!NUMERIC_BOUND_OPS.has(rule.op)) {
          throw new Error(
            `PolicyRuleSet '${set.id}': rule '${rule.id}' has invalid numeric-bound op '${rule.op}' (must be one of <= < >= > ==)`,
          );
        }
        if (typeof rule.value !== 'number' || Number.isNaN(rule.value)) {
          throw new Error(
            `PolicyRuleSet '${set.id}': rule '${rule.id}' numeric-bound value must be a finite number`,
          );
        }
        compiled.push({ ...rule, compiledPath } as CompiledPolicyRule);
        break;
      }
      case 'required':
      case 'forbidden': {
        compiled.push({ ...rule, compiledPath } as CompiledPolicyRule);
        break;
      }
      case 'conditional': {
        // Conditional rules: the rule-level jsonpath MUST equal when.jsonpath
        // per design.md ("so evidence rows surface the path that triggered
        // evaluation"). Enforced loudly so misconfigured rules don't silently
        // emit confusing evidence.
        if (!rule.when || !rule.then) {
          throw new Error(
            `PolicyRuleSet '${set.id}': rule '${rule.id}' (conditional) must define both 'when' and 'then'`,
          );
        }
        if (rule.when.jsonpath !== rule.jsonpath) {
          throw new Error(
            `PolicyRuleSet '${set.id}': rule '${rule.id}' (conditional) jsonpath must equal when.jsonpath ('${rule.jsonpath}' vs '${rule.when.jsonpath}')`,
          );
        }
        const compiledWhen = compilePredicate(set.id, rule.id, 'when', rule.when);
        const compiledThen = compilePredicate(set.id, rule.id, 'then', rule.then);
        compiled.push({
          ...rule,
          compiledPath,
          compiledWhen,
          compiledThen,
        } as CompiledPolicyRule);
        break;
      }
      case 'custom': {
        if (typeof rule.evaluate !== 'function') {
          throw new Error(
            `PolicyRuleSet '${set.id}': rule '${rule.id}' (custom) evaluate must be a function`,
          );
        }
        compiled.push({ ...rule, compiledPath } as CompiledPolicyRule);
        break;
      }
      default: {
        // Exhaustiveness check: TypeScript widens this branch to `never`,
        // and the runtime guard catches unknown kinds passed from JS.
        const _exhaustive: never = rule;
        throw new Error(
          `PolicyRuleSet '${set.id}': unknown rule kind on rule (${(_exhaustive as { kind?: unknown }).kind})`,
        );
      }
    }
  }

  // R10 soft warning. Console-level, single line. Not an error.
  if (compiled.length > LARGE_RULESET_WARN_THRESHOLD) {
    // eslint-disable-next-line no-console
    console.warn(
      `[lattice] PolicyRuleSet '${set.id}@${set.version}' has ${compiled.length} rules (>${LARGE_RULESET_WARN_THRESHOLD}); large sets are a code smell.`,
    );
  }

  return { id: set.id, version: set.version, rules: compiled };
}

function compilePredicate(
  setId: string,
  ruleId: string,
  position: 'when' | 'then',
  pred: ConditionalPredicate,
): CompiledPredicate {
  if (!pred || typeof pred !== 'object') {
    throw new Error(
      `PolicyRuleSet '${setId}': rule '${ruleId}' (conditional) '${position}' must be an object`,
    );
  }
  if (typeof pred.jsonpath !== 'string') {
    throw new Error(
      `PolicyRuleSet '${setId}': rule '${ruleId}' (conditional) '${position}.jsonpath' must be a string`,
    );
  }
  let compiledPath: CompiledJSONPath;
  try {
    compiledPath = compileJSONPath(pred.jsonpath);
  } catch (err) {
    throw new Error(
      `PolicyRuleSet '${setId}': rule '${ruleId}' (conditional) '${position}.jsonpath' invalid: ${(err as Error).message}`,
    );
  }
  if (pred.predicate === 'matches') {
    if (typeof pred.value !== 'string') {
      throw new Error(
        `PolicyRuleSet '${setId}': rule '${ruleId}' (conditional) '${position}.value' must be a string for predicate 'matches'`,
      );
    }
    return { jsonpath: pred.jsonpath, predicate: 'matches', value: pred.value, compiledPath };
  }
  if (pred.predicate === 'resolves' || pred.predicate === 'is-truthy') {
    return { jsonpath: pred.jsonpath, predicate: pred.predicate, compiledPath };
  }
  throw new Error(
    `PolicyRuleSet '${setId}': rule '${ruleId}' (conditional) '${position}.predicate' must be 'resolves' | 'is-truthy' | 'matches' (got '${(pred as { predicate?: unknown }).predicate}')`,
  );
}

/**
 * Evaluate a compiled {@link CompiledPolicyRuleSet} against a contract,
 * returning one {@link PolicyEvidenceRow} per rule in input order.
 *
 * Evidence rows are pure functions of `(rule, contract)`: identical inputs
 * yield identical rows including `detail` strings. The caller is responsible
 * for stamping `durationMs` on the surrounding `metadata.l0` record (the
 * engine has no clock dependency).
 *
 * Evaluation does NOT short-circuit on the first failure — every rule
 * produces an evidence row, so the audit trail is complete. The breaker
 * decides whether to reject based on whether ANY row has `outcome === 'fail'`.
 *
 * @param contract - The State Contract to evaluate.
 * @param compiled - The compiled rule set.
 * @returns A frozen array of evidence rows, one per rule.
 */
export function evaluatePolicy(
  contract: StateContract,
  compiled: CompiledPolicyRuleSet,
): PolicyEvidenceRow[] {
  const rows: PolicyEvidenceRow[] = [];
  for (const rule of compiled.rules) {
    rows.push(evaluateRule(contract, rule));
  }
  return rows;
}

/**
 * Evaluate a single rule. Exported only for direct unit testing of the
 * per-kind branches; production callers should go through {@link evaluatePolicy}.
 */
export function evaluateRule(
  contract: StateContract,
  rule: CompiledPolicyRule,
): PolicyEvidenceRow {
  switch (rule.kind) {
    case 'allowlist':
      return evalAllowlist(contract, rule);
    case 'denylist':
      return evalDenylist(contract, rule);
    case 'regex-deny':
      return evalRegexDeny(contract, rule);
    case 'numeric-bound':
      return evalNumericBound(contract, rule);
    case 'required':
      return evalRequired(contract, rule);
    case 'forbidden':
      return evalForbidden(contract, rule);
    case 'conditional':
      return evalConditional(contract, rule);
    case 'custom':
      return evalCustom(contract, rule);
  }
}

// ─── Per-kind helpers ───────────────────────────────────────

function row(
  rule: CompiledPolicyRule,
  outcome: 'pass' | 'fail' | 'skip',
  detail?: string,
): PolicyEvidenceRow {
  const base: PolicyEvidenceRow = {
    ruleId: rule.id,
    kind: rule.kind,
    outcome,
    jsonpath: rule.jsonpath,
  };
  if (detail !== undefined) base.detail = detail;
  return base;
}

const UNRESOLVED_DETAIL = 'jsonpath did not resolve';

function evalAllowlist(
  contract: StateContract,
  rule: CompiledPolicyRule & { kind: 'allowlist' },
): PolicyEvidenceRow {
  const r = evaluateJSONPath(contract, rule.compiledPath);
  if (!r.resolved) {
    return row(rule, 'fail', UNRESOLVED_DETAIL);
  }
  // Allowlist: every resolved value MUST be in the set. Wildcards may
  // surface multiple values; if any is outside the set, the rule fails.
  for (const v of r.values) {
    if (typeof v !== 'string' || !rule.values.includes(v)) {
      return row(rule, 'fail', `value not in allowlist of ${rule.values.length}`);
    }
  }
  return row(rule, 'pass');
}

function evalDenylist(
  contract: StateContract,
  rule: CompiledPolicyRule & { kind: 'denylist' },
): PolicyEvidenceRow {
  const r = evaluateJSONPath(contract, rule.compiledPath);
  if (!r.resolved) {
    // Per R4: denylist resolves to 'pass' when path does not resolve.
    return row(rule, 'pass');
  }
  for (const v of r.values) {
    if (typeof v === 'string' && rule.values.includes(v)) {
      return row(rule, 'fail', `value present in denylist of ${rule.values.length}`);
    }
  }
  return row(rule, 'pass');
}

function evalRegexDeny(
  contract: StateContract,
  rule: CompiledPolicyRule & { kind: 'regex-deny' },
): PolicyEvidenceRow {
  const r = evaluateJSONPath(contract, rule.compiledPath);
  if (!r.resolved) {
    // Per R4: regex-deny resolves to 'pass' when path does not resolve.
    return row(rule, 'pass');
  }
  for (const v of r.values) {
    if (v === null || v === undefined) continue;
    // Stringify defensively — R4 says "stringified value". Reset lastIndex
    // because the pre-compiled regex may carry the 'g' flag and stateful
    // RegExp.test() would otherwise skip matches across calls.
    rule.compiledRegex.lastIndex = 0;
    if (rule.compiledRegex.test(String(v))) {
      return row(rule, 'fail', `value matched deny pattern`);
    }
  }
  return row(rule, 'pass');
}

function evalNumericBound(
  contract: StateContract,
  rule: CompiledPolicyRule & { kind: 'numeric-bound' },
): PolicyEvidenceRow {
  const r = evaluateJSONPath(contract, rule.compiledPath);
  if (!r.resolved) {
    return row(rule, 'fail', UNRESOLVED_DETAIL);
  }
  for (const v of r.values) {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      return row(rule, 'fail', `value is not numeric`);
    }
    let ok: boolean;
    switch (rule.op) {
      case '<=':
        ok = v <= rule.value;
        break;
      case '<':
        ok = v < rule.value;
        break;
      case '>=':
        ok = v >= rule.value;
        break;
      case '>':
        ok = v > rule.value;
        break;
      case '==':
        ok = v === rule.value;
        break;
    }
    if (!ok) {
      return row(rule, 'fail', `value violates ${rule.op} ${rule.value}`);
    }
  }
  return row(rule, 'pass');
}

function evalRequired(
  contract: StateContract,
  rule: CompiledPolicyRule & { kind: 'required' },
): PolicyEvidenceRow {
  const r = evaluateJSONPath(contract, rule.compiledPath);
  if (!r.resolved) {
    return row(rule, 'fail', 'required path did not resolve');
  }
  // R4: must resolve to a non-null, defined value. Our evaluator already
  // strips `undefined` to "unresolved"; here we only need to reject `null`.
  for (const v of r.values) {
    if (v === null) {
      return row(rule, 'fail', 'required path resolved to null');
    }
  }
  return row(rule, 'pass');
}

function evalForbidden(
  contract: StateContract,
  rule: CompiledPolicyRule & { kind: 'forbidden' },
): PolicyEvidenceRow {
  const r = evaluateJSONPath(contract, rule.compiledPath);
  if (!r.resolved) {
    // R4: forbidden passes when path is absent.
    return row(rule, 'pass');
  }
  for (const v of r.values) {
    if (v !== null) {
      return row(rule, 'fail', 'forbidden path resolved to a value');
    }
  }
  return row(rule, 'pass');
}

function evaluatePredicate(contract: StateContract, pred: CompiledPredicate): boolean {
  const r = evaluateJSONPath(contract, pred.compiledPath);
  if (!r.resolved) return false;
  switch (pred.predicate) {
    case 'resolves': {
      // R4: 'resolves' = path resolves to non-null/non-undefined. Our
      // evaluator already drops `undefined`; we only need to reject `null`.
      // If wildcards return multiple values, every one must be non-null.
      for (const v of r.values) {
        if (v === null) return false;
      }
      return true;
    }
    case 'is-truthy': {
      for (const v of r.values) {
        if (!v) return false;
      }
      return true;
    }
    case 'matches': {
      for (const v of r.values) {
        if (typeof v !== 'string' || v !== pred.value) return false;
      }
      return true;
    }
  }
}

function evalConditional(
  contract: StateContract,
  rule: CompiledPolicyRule & { kind: 'conditional' },
): PolicyEvidenceRow {
  const whenSatisfied = evaluatePredicate(contract, rule.compiledWhen);
  if (!whenSatisfied) {
    // R4: vacuous pass when `when` is not satisfied.
    return row(rule, 'pass');
  }
  const thenSatisfied = evaluatePredicate(contract, rule.compiledThen);
  if (thenSatisfied) {
    return row(rule, 'pass');
  }
  // R4 fail detail format: 'when-satisfied-then-failed:<then.jsonpath>'
  return row(rule, 'fail', `when-satisfied-then-failed:${rule.then.jsonpath}`);
}

function evalCustom(
  contract: StateContract,
  rule: CompiledPolicyRule & { kind: 'custom' },
): PolicyEvidenceRow {
  // Custom rules are pure + sync per the spec. If a host implementation
  // throws we treat the rule as failed with a defensive detail — the
  // breaker still produces a complete evidence array, and the offending
  // rule's throw doesn't crash the L0 pass.
  let result: unknown;
  try {
    result = rule.evaluate(contract);
  } catch (err) {
    return row(rule, 'fail', `custom evaluate threw: ${(err as Error).message ?? 'unknown error'}`);
  }
  if (result === true) return row(rule, 'pass');
  if (result === false) return row(rule, 'fail', 'custom evaluate returned false');
  return row(rule, 'fail', `custom evaluate returned non-boolean (${typeof result})`);
}

/**
 * Format the reject reason produced when an L0 evaluation produces any
 * failing evidence row. Format matches R2 + design.md: `policy-deny:<id>@<v>:<ruleId>`.
 *
 * Exported so the breaker (`tiered.ts`) and adapters share one definition.
 */
export function formatPolicyDenyReason(
  set: CompiledPolicyRuleSet,
  ruleId: string,
): string {
  return `policy-deny:${set.id}@${set.version}:${ruleId}`;
}

/**
 * Convenience: find the first failing evidence row in an array. Returns
 * `undefined` if all rows passed. The breaker uses this to compute the
 * reject reason from the canonical first-failure rule ID.
 */
export function firstFailure(rows: readonly PolicyEvidenceRow[]): PolicyEvidenceRow | undefined {
  for (const r of rows) {
    if (r.outcome === 'fail') return r;
  }
  return undefined;
}

// Re-export the kind enum for callers building rule sets dynamically.
export type { PolicyRuleKind };

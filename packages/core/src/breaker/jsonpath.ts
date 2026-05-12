/**
 * Minimal JSONPath subset evaluator for the L0 policy-rules tier.
 *
 * Subset implemented (per `openspec/changes/add-l0-policy-rules/design.md`):
 *
 * - `$`                — root
 * - `.name`            — dot-notation child
 * - `['name']`         — bracket-notation child (supports keys with dots,
 *                        spaces, brackets, etc. via single-quoted strings)
 * - `[idx]`            — numeric array index (non-negative integer)
 * - `[*]`              — wildcard over array elements OR object values
 *
 * Explicitly NOT supported (must throw at compile time):
 *
 * - `..`               — recursive descent
 * - `?(...)`           — filter expressions
 * - `[a,b]` / `[1:3]`  — union / slice
 * - `@.foo`            — current-node references
 * - script expressions
 *
 * The evaluator is pure + sync. No `Date.now()`, no `Math.random()`, no I/O.
 *
 * Result shape: {@link JSONPathResult} carries an explicit `resolved` flag so
 * callers can distinguish "path resolved to `undefined`/`null`" (which is a
 * valid resolution) from "path did not resolve" (which is a structural miss).
 * The L0 engine relies on this distinction for `required` / `forbidden` /
 * other rule kinds.
 */

/**
 * A single accessor step in a compiled JSONPath. The compiler emits one of
 * these per `.name` / `['name']` / `[idx]` / `[*]` token, applied in order
 * to the root value.
 */
export type JSONPathStep =
  | { kind: 'key'; name: string }
  | { kind: 'index'; idx: number }
  | { kind: 'wildcard' };

/**
 * A compiled JSONPath: the raw source plus the list of accessor steps. Cached
 * per-rule at `PolicyRuleSet` construction time so evaluation is O(depth).
 */
export interface CompiledJSONPath {
  source: string;
  steps: JSONPathStep[];
}

/**
 * Result of evaluating a {@link CompiledJSONPath} against a value.
 *
 * - `resolved: true`  — the path landed on at least one defined value (which
 *   may itself be `null`). `values` contains the matched values in document
 *   order. `value` is `values[0]` for convenience (single-value paths).
 * - `resolved: false` — the path missed at every step (e.g., a key not on
 *   the object, an out-of-range index, or a wildcard over an empty array).
 *   `values` is empty.
 *
 * Wildcards may produce zero, one, or many values; rule kinds that care
 * about scalar comparison (`allowlist`, `numeric-bound`, …) should inspect
 * `values` explicitly.
 */
export interface JSONPathResult {
  resolved: boolean;
  /** Matched values in traversal order. Empty when `resolved === false`. */
  values: unknown[];
  /** Convenience for scalar paths: `values[0]`. `undefined` if `resolved === false`. */
  value: unknown;
}

/**
 * Compile a JSONPath string into a list of accessor steps.
 *
 * Throws on:
 *   - Missing `$` root
 *   - Unsupported tokens (`..`, `?`, `,`, `:`, `@`)
 *   - Malformed brackets (unbalanced, missing quotes, etc.)
 *   - Negative or non-integer indices
 *
 * The error message includes the offending path so `PolicyRuleSet`
 * construction can surface it directly to the caller.
 *
 * @param path - The JSONPath source string.
 * @returns A {@link CompiledJSONPath} that can be passed to {@link evaluateJSONPath}.
 */
export function compileJSONPath(path: string): CompiledJSONPath {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`JSONPath must be a non-empty string (got ${typeof path})`);
  }
  if (path[0] !== '$') {
    throw new Error(`JSONPath must start with '$' (got '${path}')`);
  }
  // Reject features outside the supported subset before we walk the string —
  // these produce clearer errors than the per-token failures below.
  if (path.includes('..')) {
    throw new Error(`JSONPath recursive descent ('..') is not supported in the L0 subset: '${path}'`);
  }
  if (path.includes('?')) {
    throw new Error(`JSONPath filter expressions ('?(...)') are not supported in the L0 subset: '${path}'`);
  }
  if (path.includes('@')) {
    throw new Error(`JSONPath current-node references ('@') are not supported in the L0 subset: '${path}'`);
  }

  const steps: JSONPathStep[] = [];
  let i = 1; // skip the leading '$'

  while (i < path.length) {
    const ch = path[i];

    if (ch === '.') {
      // Dot-notation child: `.name` where `name` is [A-Za-z_][A-Za-z0-9_]*.
      // We intentionally keep the identifier rule narrow; anything richer
      // must use bracket-notation.
      i++;
      if (i >= path.length) {
        throw new Error(`JSONPath dangling '.' at end of '${path}'`);
      }
      if (path[i] === '.') {
        throw new Error(`JSONPath recursive descent ('..') is not supported in the L0 subset: '${path}'`);
      }
      const start = i;
      while (i < path.length && /[A-Za-z0-9_]/.test(path[i])) {
        i++;
      }
      if (i === start) {
        throw new Error(`JSONPath missing identifier after '.' in '${path}'`);
      }
      const name = path.slice(start, i);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`JSONPath invalid identifier '${name}' after '.' in '${path}' (use bracket notation for non-identifier keys)`);
      }
      steps.push({ kind: 'key', name });
      continue;
    }

    if (ch === '[') {
      // Bracket-notation: `['name']`, `[idx]`, or `[*]`. We disallow
      // commas (union) and colons (slice) explicitly because both are
      // valid JSONPath but outside the L0 subset.
      const end = path.indexOf(']', i + 1);
      if (end === -1) {
        throw new Error(`JSONPath unterminated bracket at index ${i} in '${path}'`);
      }
      const body = path.slice(i + 1, end);
      if (body.includes(',')) {
        throw new Error(`JSONPath union ('[a,b]') is not supported in the L0 subset: '${path}'`);
      }
      if (body.includes(':')) {
        throw new Error(`JSONPath slice ('[a:b]') is not supported in the L0 subset: '${path}'`);
      }
      if (body.length === 0) {
        throw new Error(`JSONPath empty brackets in '${path}'`);
      }

      if (body === '*') {
        steps.push({ kind: 'wildcard' });
      } else if (body[0] === "'") {
        // Quoted key: `['name']`. We do not support backslash escapes inside
        // the quotes because (a) they're rare in policy contexts and (b)
        // permitting them invites parser complexity without test coverage.
        if (body[body.length - 1] !== "'") {
          throw new Error(`JSONPath unterminated quoted key in '${path}' near '${body}'`);
        }
        const inner = body.slice(1, -1);
        if (inner.includes("'")) {
          throw new Error(`JSONPath escape sequences inside quoted keys are not supported in the L0 subset: '${path}'`);
        }
        steps.push({ kind: 'key', name: inner });
      } else if (/^[0-9]+$/.test(body)) {
        // Non-negative integer index. JSONPath spec allows negative indices
        // (from-end), but supporting them here would conflict with the
        // "deterministic at compile time" property — array length is only
        // known at evaluation time, so a negative index could silently
        // become a different positive index across runs. Reject loudly.
        const idx = parseInt(body, 10);
        steps.push({ kind: 'index', idx });
      } else {
        throw new Error(`JSONPath unsupported bracket content '[${body}]' in '${path}'`);
      }

      i = end + 1;
      continue;
    }

    throw new Error(`JSONPath unexpected character '${ch}' at index ${i} in '${path}'`);
  }

  return { source: path, steps };
}

/**
 * Evaluate a compiled JSONPath against a root value.
 *
 * Traversal semantics:
 *
 * - `key` against an object → match `obj[name]` if the key is an own property.
 * - `key` against anything else → miss.
 * - `index` against an array → match `arr[idx]` if `0 <= idx < arr.length`.
 * - `wildcard` against an array → match each element in order.
 * - `wildcard` against an object → match each own value in key-insertion order.
 * - `wildcard` against anything else → miss.
 *
 * Wildcards may produce zero, one, or many concurrent traversal frontiers.
 * Subsequent steps apply to every frontier; `resolved` is `true` iff at least
 * one frontier survives all steps.
 *
 * A path that resolves to a property whose value is `undefined` is considered
 * UNRESOLVED — JavaScript treats `obj[k] === undefined` as semantically
 * equivalent to "missing". A property whose value is `null` is RESOLVED
 * (callers wanting "not null" should use the `required` rule kind).
 *
 * @param root - The value to evaluate against (typically a StateContract).
 * @param compiled - The {@link CompiledJSONPath} from {@link compileJSONPath}.
 * @returns A {@link JSONPathResult} with `resolved`, `values`, and `value`.
 */
export function evaluateJSONPath(root: unknown, compiled: CompiledJSONPath): JSONPathResult {
  let frontier: unknown[] = [root];

  for (const step of compiled.steps) {
    const next: unknown[] = [];

    for (const node of frontier) {
      if (step.kind === 'key') {
        if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
          const obj = node as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(obj, step.name)) {
            const v = obj[step.name];
            // Treat `undefined` values as unresolved — matches JS semantics
            // for "property exists but is undefined" vs. "property missing".
            // Either way, the L0 engine cannot distinguish them downstream,
            // so we collapse them here for clarity.
            if (v !== undefined) next.push(v);
          }
        }
      } else if (step.kind === 'index') {
        if (Array.isArray(node) && step.idx >= 0 && step.idx < node.length) {
          const v = node[step.idx];
          if (v !== undefined) next.push(v);
        }
      } else {
        // wildcard
        if (Array.isArray(node)) {
          for (const v of node) {
            if (v !== undefined) next.push(v);
          }
        } else if (node !== null && typeof node === 'object') {
          const obj = node as Record<string, unknown>;
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (v !== undefined) next.push(v);
          }
        }
      }
    }

    frontier = next;
    if (frontier.length === 0) {
      // Short-circuit: once the frontier collapses, no later step can
      // recover it. Return unresolved.
      return { resolved: false, values: [], value: undefined };
    }
  }

  return { resolved: true, values: frontier, value: frontier[0] };
}

/**
 * Canonical JSON serialization utilities.
 *
 * Centralizes the "deterministic stringify" logic used by:
 *  - {@link ConsensusReducer.serializeValue} (hash equality across agents)
 *  - The compliance audit log's `computeHash` (chain integrity)
 *  - Any caller that needs a stable cross-process hash key for a payload
 *
 * Design goals:
 *  - **Recursive**: keys are sorted at every depth, not just the top level.
 *  - **Non-mutating**: the caller's input is never reordered. Arrays whose
 *    *contents* are objects are walked, but element order is preserved
 *    (arrays are ordered by definition; only object keys are sorted).
 *  - **Single-pass**: emits the JSON string directly while traversing,
 *    avoiding an intermediate fully-cloned-and-sorted object graph.
 *  - **Memoizable**: a {@link CanonicalMemo} can be threaded through one
 *    logical "step" (e.g. a single tiered-circuit-breaker validation) so the
 *    same payload reference is canonicalized at most once.
 *
 * NOTE on array semantics: this canonicalizer does NOT sort array elements.
 * Two arrays with the same elements in different orders are treated as
 * distinct. Callers that require order-insensitive array equality must
 * normalize the array themselves before passing it in. (The previous
 * `ConsensusReducer.serializeValue` implementation sorted arrays in place,
 * which both mutated the caller and conflated "same multiset" with "same
 * sequence". We deliberately do not preserve that behavior — see issue #11.)
 */

/**
 * A WeakMap-backed memo for {@link canonicalize} results. Keyed by object /
 * array reference; primitives are cheap to canonicalize and skip the memo.
 *
 * Lifetime should be one logical step (a single validation pass, a single
 * audit append, etc.). Outliving the step is harmless but wastes memory.
 */
export class CanonicalMemo {
  private readonly cache = new WeakMap<object, string>();

  get(key: object): string | undefined {
    return this.cache.get(key);
  }

  set(key: object, value: string): void {
    this.cache.set(key, value);
  }
}

/**
 * Produce a canonical JSON string for `value`.
 *
 * - Object keys are sorted lexicographically at every depth.
 * - Arrays preserve element order; nested objects/arrays are recursed into.
 * - The input value is not mutated.
 * - `undefined` and functions are emitted as `null` (matching `JSON.stringify`
 *   semantics for object values; top-level `undefined` becomes the string
 *   `"undefined"` so callers can distinguish it from `null`).
 *
 * @param value - The value to canonicalize.
 * @param memo  - Optional {@link CanonicalMemo} to dedupe repeated canonicalization
 *                of the same object reference within one logical step.
 */
export function canonicalize(value: unknown, memo?: CanonicalMemo): string {
  // Top-level fast paths for primitive markers used by the consensus reducer.
  if (value === undefined) return 'undefined';
  return emit(value, memo);
}

/**
 * Recursive emitter. Returns the JSON-shaped substring for `value`.
 * Internal — call {@link canonicalize} from outside this module.
 */
function emit(value: unknown, memo?: CanonicalMemo): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (t === 'boolean') return (value as boolean) ? 'true' : 'false';
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  if (t === 'bigint') return JSON.stringify((value as bigint).toString());

  // Object or array.
  const obj = value as object;

  if (memo) {
    const cached = memo.get(obj);
    if (cached !== undefined) return cached;
  }

  let out: string;
  if (Array.isArray(obj)) {
    let s = '[';
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) s += ',';
      s += emit(obj[i], memo);
    }
    s += ']';
    out = s;
  } else {
    // Sort own enumerable string keys without mutating the source.
    const keys = Object.keys(obj as Record<string, unknown>);
    keys.sort();
    let s = '{';
    let wrote = 0;
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      // Match JSON.stringify: skip keys whose value is undefined/function/symbol
      // when at object-value position (these are the values JSON.stringify drops).
      const vt = typeof v;
      if (v === undefined || vt === 'function' || vt === 'symbol') continue;
      if (wrote > 0) s += ',';
      s += JSON.stringify(k) + ':' + emit(v, memo);
      wrote++;
    }
    s += '}';
    out = s;
  }

  if (memo) memo.set(obj, out);
  return out;
}

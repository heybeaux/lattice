import { StateContract } from '../contract/types.js';

/**
 * Sensitivity levels for contract field classification.
 */
export type SensitivityLevel = 'low' | 'medium' | 'high';

/**
 * Options for the redaction utility.
 */
export interface RedactOptions {
  /** Minimum sensitivity level to redact (default: 'high') */
  sensitivityLevel?: SensitivityLevel;
  /** Placeholder for redacted values (default: '[REDACTED]') */
  placeholder?: string;
  /** Additional field paths to redact (dot notation, applied at root) */
  additionalPaths?: string[];
  /**
   * Additional case-insensitive key names to redact at any depth.
   * Use this to extend the built-in deny-list.
   */
  additionalKeyNames?: string[];
}

/**
 * Options for the top-level {@link redactJson} primitive (Spec 1 R11).
 */
export interface RedactJsonOptions {
  /** Minimum sensitivity level to redact. */
  sensitivityLevel: SensitivityLevel;
  /**
   * JSONPaths that MUST NOT be redacted. If a redaction would land on any
   * of these paths, {@link redactJson} returns immediately with
   * `refusalPath` set to the first offending path; no further redactions
   * are applied. Paths use the same string syntax as the L0 JSONPath
   * subset (`$`, `.name`, `['name']`, `[idx]`, but NOT `[*]`/`..`).
   */
  mustNotRedact?: readonly string[];
  /** Placeholder for redacted values (default: '[REDACTED]'). */
  placeholder?: string;
  /** Additional case-insensitive key names to redact at any depth. */
  additionalKeyNames?: readonly string[];
}

/**
 * Result of a {@link redactJson} call (Spec 1 R11).
 *
 * - `redacted` — the (deeply-cloned) tree with sensitive values replaced.
 * - `fields` — JSONPaths of every field whose value was replaced, in
 *   traversal order. Duplicates are possible if a pattern matched inside
 *   a value that a key-name rule had already replaced (the second match
 *   re-records the path).
 * - `refusalPath` — if a `mustNotRedact` entry blocked a redaction, the
 *   first offending JSONPath. When `refusalPath` is set, `fields` reflects
 *   the redactions that ran BEFORE the refusal short-circuited the pass,
 *   and `redacted` is the partial result. Sonder (Spec 2) treats any
 *   non-undefined `refusalPath` as a hard failure.
 */
export interface RedactJsonResult {
  redacted: unknown;
  fields: string[];
  refusalPath?: string;
}

/**
 * Case-insensitive key-name pattern. Matches any property whose key is one of
 * the well-known credential names at ANY depth in the contract tree. Replaces
 * the prior exact-dot-path approach which only matched top-level payload keys
 * and missed nested credentials (issue #7 / SEC-005).
 *
 * Anchored with `^...$` after lower-casing so we don't accidentally redact
 * fields like `apiKeyExplanation` or `tokenCount`.
 */
const SENSITIVE_KEY_PATTERN =
  /^(api[_-]?key|secret|secret[_-]?key|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|authorization|auth|cookie|set[_-]?cookie|session[_-]?id|client[_-]?secret|private[_-]?key|connection[_-]?string|conn[_-]?str|mongo[_-]?uri|db[_-]?password|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id|x[_-]?api[_-]?key)$/;

/**
 * Top-level contract sections to traverse for nested key/pattern redaction.
 * Decisions, constraints, and assumptions are now scanned (issue #7) — they
 * frequently embed credentials in rationale strings, error messages, etc.
 */
const TRAVERSED_SECTIONS = [
  'inputs',
  'outputs',
  'metadata',
  'decisions',
  'constraints',
  'assumptions',
] as const;

/**
 * Pattern detectors for known secret formats. Applied to all string values in
 * traversed sections, regardless of key name. These run AFTER key-name
 * redaction, so a value already replaced with the placeholder won't match.
 *
 * NOTE: ordering matters slightly — provider-specific patterns are checked
 * before the generic high-entropy fallback so the replacement message is more
 * useful in audit logs.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // GitHub PATs (classic + fine-grained)
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  /\bgh[osu]_[A-Za-z0-9]{36}\b/g,
  // AWS access keys
  /\bAKIA[0-9A-Z]{16}\b/g,
  // JWTs (header.payload.signature, all base64url)
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // Anthropic
  /\bsk-ant-[A-Za-z0-9_-]+\b/g,
  // OpenAI (project + classic)
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  // Stripe (live + test, secret + publishable)
  /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
  /\bpk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
  // Slack
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  // PEM private keys (SSH, RSA, EC, etc.)
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
];

/** Email pattern (used at medium+ sensitivity). Fixes the `[A-Z|a-z]` typo. */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Phone numbers, including E.164 format. */
const PHONE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  /\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}\b/g,
];

/** SSN: hyphenated and unhyphenated 9-digit. */
const SSN_PATTERNS: ReadonlyArray<RegExp> = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?!000|666|9\d{2})\d{9}\b/g,
];

/** Credit card numbers (Luhn-shaped 13-19 digit groups). */
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

/**
 * Redact sensitive data from a State Contract.
 *
 * Walks the entire contract tree (inputs, outputs, metadata, decisions,
 * constraints, assumptions) and:
 *   1. Replaces any property whose key matches a well-known credential name
 *      (api_key, password, token, Authorization, ...) — case-insensitive,
 *      at any depth.
 *   2. Scans every string value for known secret token formats (GitHub PATs,
 *      AWS keys, JWTs, OpenAI/Anthropic/Stripe/Slack tokens, PEM blocks).
 *   3. At medium+ sensitivity, also redacts email addresses.
 *   4. At high sensitivity, also redacts phone numbers, SSNs, and credit
 *      card-shaped strings.
 *
 * The contract structure and keys are preserved — only values change. The
 * returned object is frozen to prevent downstream mutation.
 *
 * @param contract - The State Contract to redact
 * @param options - Redaction options
 * @returns A new (deeply-cloned, frozen) State Contract with sensitive values redacted
 */
export function redactContract<TIn = unknown, TOut = unknown>(
  contract: StateContract<TIn, TOut>,
  options?: RedactOptions,
): StateContract<TIn, TOut> {
  const sensitivity = options?.sensitivityLevel ?? 'high';
  const placeholder = options?.placeholder ?? '[REDACTED]';
  const additionalPaths = options?.additionalPaths ?? [];
  const additionalKeyNames = options?.additionalKeyNames ?? [];

  // Deep-clone before mutation so the caller's contract is unchanged.
  const redacted = JSON.parse(JSON.stringify(contract)) as StateContract<TIn, TOut>;

  // Run the shared {@link redactJson} primitive over each TRAVERSED_SECTION
  // in place. We MUST go section-by-section (not over the whole contract)
  // because top-level fields like `id`, `traceId`, `timestamp` carry
  // structurally-required values that look like secrets (e.g. a ULID may
  // collide with the OpenAI sk- pattern) — historic redactContract has
  // never touched them and the public signature MUST NOT change.
  for (const section of TRAVERSED_SECTIONS) {
    const node = (redacted as unknown as Record<string, unknown>)[section];
    if (node === undefined) continue;
    // The primitive returns a (possibly new) tree; we re-attach it to the
    // section slot. For object/array sections JSON.parse already gave us a
    // fresh reference, but the assignment keeps the code uniform.
    const r = redactJson(node, {
      sensitivityLevel: sensitivity,
      placeholder,
      additionalKeyNames,
    });
    (redacted as unknown as Record<string, unknown>)[section] = r.redacted;
  }

  // Caller-provided dot-paths (root-anchored, exact match, back-compat).
  // These run AFTER the section sweep so additionalPaths can still hit
  // top-level slots that redactJson didn't visit.
  for (const path of additionalPaths) {
    redactPath(redacted, path, placeholder);
  }

  return deepFreeze(redacted) as StateContract<TIn, TOut>;
}

/**
 * Top-level redaction primitive (Spec 1 R11). Walks an arbitrary JSON tree
 * and applies the Lattice secret-detection rules: built-in credential key
 * names, known token formats, plus PII patterns at medium/high sensitivity.
 *
 * Behavior:
 *
 *   1. Deep-clones the input via `JSON.parse(JSON.stringify(tree))` so the
 *      caller's tree is unchanged. (Cyclic input would already throw at the
 *      stringify step; that matches `redactContract`'s prior behavior.)
 *   2. Walks the clone and replaces values that match either the built-in
 *      key-name pattern (`api_key`, `password`, ...) or any caller-supplied
 *      `additionalKeyNames`.
 *   3. Walks the clone again with the secret/PII regexes. At `'low'` we run
 *      only provider-token patterns. At `'medium'` we add emails. At
 *      `'high'` we add phone/SSN/credit-card.
 *   4. Each time a value is replaced, the JSONPath of that field is pushed
 *      onto `result.fields`. The path uses the same syntax as the L0 subset.
 *   5. If any redaction would land on a path in `mustNotRedact`, the
 *      primitive short-circuits and returns the offending path in
 *      `result.refusalPath`. No further redactions are applied. The partial
 *      tree is still returned in `result.redacted` so callers can inspect it.
 *
 * Sonder (Spec 2) consumes this directly. `redactContract` wraps it
 * section-by-section so the contract's structural top-level fields (id,
 * traceId, timestamp, ...) stay untouched.
 *
 * @param tree - The JSON tree to redact. Mutating the result is safe; the
 *   input is not modified.
 * @param opts - Sensitivity level, optional refusal paths, optional
 *   additional key names, optional placeholder.
 * @returns A {@link RedactJsonResult}.
 */
export function redactJson(tree: unknown, opts: RedactJsonOptions): RedactJsonResult {
  const sensitivity = opts.sensitivityLevel;
  const placeholder = opts.placeholder ?? '[REDACTED]';
  const additionalKeyNames = opts.additionalKeyNames ?? [];
  const mustNotRedact = new Set(opts.mustNotRedact ?? []);
  const additionalKeySet = new Set(additionalKeyNames.map((k) => k.toLowerCase()));

  // Deep-clone so the caller's tree is unchanged. Stays consistent with
  // historic redactContract behavior, including throwing on cycles.
  const cloned: unknown = tree === undefined ? undefined : JSON.parse(JSON.stringify(tree));

  const fields: string[] = [];
  // refusalPath is set by the walker as soon as we'd land on a protected path.
  // We thread it through as a single-slot container so the recursive walker
  // can short-circuit without throwing.
  const refusal: { path?: string } = {};

  if (cloned === undefined) {
    return { redacted: cloned, fields };
  }

  // 1) Key-name sweep across the whole tree.
  walkKeyName(cloned, '$', additionalKeySet, placeholder, mustNotRedact, fields, refusal);
  if (refusal.path) return { redacted: cloned, fields, refusalPath: refusal.path };

  // 2) Provider/secret-token patterns over every string value.
  for (const pattern of SECRET_PATTERNS) {
    walkPattern(cloned, '$', pattern, placeholder, mustNotRedact, fields, refusal);
    if (refusal.path) return { redacted: cloned, fields, refusalPath: refusal.path };
  }

  if (sensitivity === 'medium' || sensitivity === 'high') {
    walkPattern(cloned, '$', EMAIL_PATTERN, placeholder, mustNotRedact, fields, refusal);
    if (refusal.path) return { redacted: cloned, fields, refusalPath: refusal.path };
  }

  if (sensitivity === 'high') {
    for (const pattern of PHONE_PATTERNS) {
      walkPattern(cloned, '$', pattern, placeholder, mustNotRedact, fields, refusal);
      if (refusal.path) return { redacted: cloned, fields, refusalPath: refusal.path };
    }
    for (const pattern of SSN_PATTERNS) {
      walkPattern(cloned, '$', pattern, placeholder, mustNotRedact, fields, refusal);
      if (refusal.path) return { redacted: cloned, fields, refusalPath: refusal.path };
    }
    walkPattern(cloned, '$', CREDIT_CARD_PATTERN, placeholder, mustNotRedact, fields, refusal);
    if (refusal.path) return { redacted: cloned, fields, refusalPath: refusal.path };
  }

  return { redacted: cloned, fields };
}

/** Concatenate the parent JSONPath with a child key-name step. */
function joinKey(parent: string, key: string): string {
  // Identifier keys use the dot form; non-identifier keys use bracket form
  // so the resulting path round-trips through compileJSONPath.
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `${parent}.${key}`;
  return `${parent}['${key}']`;
}

/** Concatenate the parent JSONPath with a child array-index step. */
function joinIndex(parent: string, idx: number): string {
  return `${parent}[${idx}]`;
}

/**
 * Recursively freeze an object graph to make it deeply immutable.
 * Handles arrays, plain objects, and prevents infinite loops on cycles.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;

  const visited = new WeakSet<object>();

  function freeze(node: unknown): unknown {
    if (node === null || typeof node !== 'object') return node;

    // Prevent infinite loops on cycles
    if (visited.has(node as object)) return node;
    visited.add(node as object);

    // Freeze the node itself
    Object.freeze(node);

    // Recursively freeze properties/elements
    if (Array.isArray(node)) {
      for (const item of node) {
        freeze(item);
      }
    } else {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        freeze((node as Record<string, unknown>)[key]);
      }
    }

    return node;
  }

  return freeze(obj) as T;
}

/**
 * Walk an object tree (recording its JSONPath) and replace any property
 * whose key (case-insensitive) matches the built-in
 * {@link SENSITIVE_KEY_PATTERN} or the caller's additional set.
 *
 * Each replacement pushes the field's JSONPath onto `fields`. If the field's
 * path matches an entry in `mustNotRedact`, the walker writes the first
 * offending path into `refusal.path` and returns without redacting it.
 * Callers check `refusal.path` after the walker returns.
 *
 * Mutates `node` in place; the caller is responsible for deep-cloning first.
 */
function walkKeyName(
  node: unknown,
  path: string,
  additional: ReadonlySet<string>,
  placeholder: string,
  mustNotRedact: ReadonlySet<string>,
  fields: string[],
  refusal: { path?: string },
): void {
  if (refusal.path) return;
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkKeyName(node[i], joinIndex(path, i), additional, placeholder, mustNotRedact, fields, refusal);
      if (refusal.path) return;
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (refusal.path) return;
    const lower = key.toLowerCase();
    const childPath = joinKey(path, key);
    if (SENSITIVE_KEY_PATTERN.test(lower) || additional.has(lower)) {
      if (mustNotRedact.has(childPath)) {
        refusal.path = childPath;
        return;
      }
      obj[key] = placeholder;
      fields.push(childPath);
      continue;
    }
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      walkKeyName(value, childPath, additional, placeholder, mustNotRedact, fields, refusal);
    }
  }
}

/**
 * Redact a value at a dot-notation path in an object. Kept for back-compat
 * with `additionalPaths`; new code should prefer `additionalKeyNames`.
 */
function redactPath(obj: unknown, path: string, placeholder: string): void {
  const parts = path.split('.');
  let current = obj as Record<string, unknown> | null;

  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || typeof current !== 'object' || !(parts[i] in current)) {
      return;
    }
    current = current[parts[i]] as Record<string, unknown>;
  }

  const lastKey = parts[parts.length - 1];
  if (current !== null && typeof current === 'object' && lastKey in current) {
    (current as Record<string, unknown>)[lastKey] = placeholder;
  }
}

/**
 * Walk a tree (recording its JSONPath) and run `pattern.replace` against
 * every string value. Non-string values descend; matching values are
 * replaced with `placeholder` and their JSONPath is pushed onto `fields`.
 *
 * Mutates in place. As with {@link walkKeyName}, `mustNotRedact` short-
 * circuits the walk by writing the first offending path into
 * `refusal.path`.
 *
 * IMPORTANT: `pattern.lastIndex = 0` is reset before each `String.replace`
 * because stateful `/g` regexes shared at module scope can otherwise skip
 * matches after the first call.
 */
function walkPattern(
  node: unknown,
  path: string,
  pattern: RegExp,
  placeholder: string,
  mustNotRedact: ReadonlySet<string>,
  fields: string[],
  refusal: { path?: string },
): void {
  if (refusal.path) return;
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (refusal.path) return;
      const v = node[i];
      const childPath = joinIndex(path, i);
      if (typeof v === 'string') {
        pattern.lastIndex = 0;
        if (pattern.test(v)) {
          if (mustNotRedact.has(childPath)) {
            refusal.path = childPath;
            return;
          }
          pattern.lastIndex = 0;
          node[i] = v.replace(pattern, placeholder);
          fields.push(childPath);
        }
      } else if (v !== null && typeof v === 'object') {
        walkPattern(v, childPath, pattern, placeholder, mustNotRedact, fields, refusal);
      }
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (refusal.path) return;
    const value = obj[key];
    const childPath = joinKey(path, key);

    if (typeof value === 'string') {
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        if (mustNotRedact.has(childPath)) {
          refusal.path = childPath;
          return;
        }
        pattern.lastIndex = 0;
        obj[key] = value.replace(pattern, placeholder);
        fields.push(childPath);
      }
    } else if (typeof value === 'object' && value !== null) {
      walkPattern(value, childPath, pattern, placeholder, mustNotRedact, fields, refusal);
    }
  }
}

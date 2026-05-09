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

  const redacted = JSON.parse(JSON.stringify(contract)) as StateContract<TIn, TOut>;

  const additionalKeySet = new Set(additionalKeyNames.map((k) => k.toLowerCase()));

  // 1. Tree-walk redaction by key name across every traversed section.
  for (const section of TRAVERSED_SECTIONS) {
    const node = (redacted as unknown as Record<string, unknown>)[section];
    if (node !== undefined) {
      redactByKeyName(node, additionalKeySet, placeholder);
    }
  }

  // 2. Caller-provided dot-paths (root-anchored, exact match, back-compat).
  for (const path of additionalPaths) {
    redactPath(redacted, path, placeholder);
  }

  // 3. Provider/secret-token patterns over all string values in traversed
  //    sections (independent of key name).
  for (const section of TRAVERSED_SECTIONS) {
    const node = (redacted as unknown as Record<string, unknown>)[section];
    if (node !== undefined) {
      for (const pattern of SECRET_PATTERNS) {
        redactPattern(node, pattern, placeholder);
      }
    }
  }

  if (sensitivity === 'medium' || sensitivity === 'high') {
    for (const section of TRAVERSED_SECTIONS) {
      const node = (redacted as unknown as Record<string, unknown>)[section];
      if (node !== undefined) {
        redactPattern(node, EMAIL_PATTERN, placeholder);
      }
    }
  }

  if (sensitivity === 'high') {
    for (const section of TRAVERSED_SECTIONS) {
      const node = (redacted as unknown as Record<string, unknown>)[section];
      if (node === undefined) continue;
      for (const pattern of PHONE_PATTERNS) {
        redactPattern(node, pattern, placeholder);
      }
      for (const pattern of SSN_PATTERNS) {
        redactPattern(node, pattern, placeholder);
      }
      redactPattern(node, CREDIT_CARD_PATTERN, placeholder);
    }
  }

  return deepFreeze(redacted) as StateContract<TIn, TOut>;
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
 * Walk an object tree and replace any property whose key (case-insensitive)
 * matches the built-in {@link SENSITIVE_KEY_PATTERN} or the caller's
 * additional set. Arrays and nested objects are descended recursively.
 *
 * Note: we mutate in place because the caller already deep-cloned via
 * `JSON.parse(JSON.stringify(...))`.
 */
function redactByKeyName(
  node: unknown,
  additional: ReadonlySet<string>,
  placeholder: string,
): void {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) redactByKeyName(item, additional, placeholder);
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEY_PATTERN.test(lower) || additional.has(lower)) {
      obj[key] = placeholder;
      continue;
    }
    const value = obj[key];
    if (value !== null && typeof value === 'object') {
      redactByKeyName(value, additional, placeholder);
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
 * Redact substrings matching `pattern` inside every string value reached
 * by walking `obj`. Non-string values are descended (arrays + objects).
 *
 * IMPORTANT: regex `lastIndex` is reset before each `String.replace` because
 * stateful `/g` regexes shared at module scope can otherwise skip matches
 * after the first call.
 */
function redactPattern(obj: unknown, pattern: RegExp, placeholder: string): void {
  if (obj === null || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      if (typeof v === 'string') {
        pattern.lastIndex = 0;
        obj[i] = v.replace(pattern, placeholder);
      } else if (v !== null && typeof v === 'object') {
        redactPattern(v, pattern, placeholder);
      }
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];

    if (typeof value === 'string') {
      pattern.lastIndex = 0;
      (obj as Record<string, unknown>)[key] = value.replace(pattern, placeholder);
    } else if (typeof value === 'object' && value !== null) {
      redactPattern(value, pattern, placeholder);
    }
  }
}

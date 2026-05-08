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
  /** Additional field paths to redact (dot notation) */
  additionalPaths?: string[];
}

/**
 * Default sensitive field paths that should always be redacted.
 */
const DEFAULT_SENSITIVE_PATHS = new Set([
  'inputs.payload.apiKey',
  'inputs.payload.api_key',
  'inputs.payload.password',
  'inputs.payload.passwd',
  'inputs.payload.secret',
  'inputs.payload.secretKey',
  'inputs.payload.token',
  'inputs.payload.accessToken',
  'inputs.payload.authorization',
  'outputs.payload.apiKey',
  'outputs.payload.api_key',
  'outputs.payload.password',
  'outputs.payload.passwd',
  'outputs.payload.secret',
  'outputs.payload.secretKey',
  'outputs.payload.token',
  'outputs.payload.accessToken',
  'outputs.payload.authorization',
  'metadata.apiKey',
  'metadata.api_key',
  'metadata.password',
  'metadata.passwd',
  'metadata.secret',
  'metadata.secretKey',
  'metadata.token',
  'metadata.accessToken',
  'metadata.authorization',
]);

/**
 * Redact sensitive data from a State Contract.
 *
 * Scans the contract for sensitive fields and replaces their values
 * with a placeholder. The contract structure is preserved — only values
 * are redacted, field names remain for audit purposes.
 *
 * @param contract - The State Contract to redact
 * @param options - Redaction options
 * @returns A new State Contract with sensitive values redacted
 *
 * @example
 * ```ts
 * const redacted = redactContract(contract, { sensitivityLevel: 'high' });
 * // All fields marked as sensitive are replaced with [REDACTED]
 * ```
 */
export function redactContract<TIn = unknown, TOut = unknown>(
  contract: StateContract<TIn, TOut>,
  options?: RedactOptions,
): StateContract<TIn, TOut> {
  const sensitivity = options?.sensitivityLevel ?? 'high';
  const placeholder = options?.placeholder ?? '[REDACTED]';
  const additionalPaths = options?.additionalPaths ?? [];

  const redacted = JSON.parse(JSON.stringify(contract)) as StateContract<TIn, TOut>;

  // Redact default sensitive paths
  for (const path of DEFAULT_SENSITIVE_PATHS) {
    redactPath(redacted, path, placeholder);
  }

  // Redact additional paths
  for (const path of additionalPaths) {
    redactPath(redacted, path, placeholder);
  }

  // Redact based on sensitivity level
  if (sensitivity === 'medium' || sensitivity === 'high') {
    // Redact email-like patterns in payload strings
    redactPattern(redacted, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, placeholder);
  }

  if (sensitivity === 'high') {
    // Redact phone numbers
    redactPattern(redacted, /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, placeholder);
    // Redact SSN-like patterns
    redactPattern(redacted, /\b\d{3}-\d{2}-\d{4}\b/g, placeholder);
  }

  return Object.freeze(redacted) as StateContract<TIn, TOut>;
}

/**
 * Redact a value at a dot-notation path in an object.
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
 * Redact values matching a regex pattern throughout an object tree.
 */
function redactPattern(obj: unknown, pattern: RegExp, placeholder: string): void {
  if (obj === null || typeof obj !== 'object') return;

  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];

    if (typeof value === 'string') {
      (obj as Record<string, unknown>)[key] = value.replace(pattern, placeholder);
    } else if (typeof value === 'object' && value !== null) {
      redactPattern(value, pattern, placeholder);
    }
  }
}

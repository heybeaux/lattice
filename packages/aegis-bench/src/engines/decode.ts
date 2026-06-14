/**
 * Decode-then-rescan engine (config `regex+decode`, spec §2.2 / Phase 5).
 *
 * A real, working deobfuscator — NOT a stub. Given a shell command, it produces a set
 * of decoded candidate strings by reversing three common obfuscation techniques:
 *
 *   1. base64  — both explicit `... | base64 -d | sh` pipelines AND bare decodable blobs.
 *   2. hex     — `\xNN` and ANSI-C `$'\xNN'` escape sequences.
 *   3. var-indirection — `X=rm; $X -rf /` → resolve simple assignments, then substitute.
 *
 * The benchmark evaluates the original command AND each decoded candidate, taking the
 * strictest verdict (deny > ask > allow). That is how `regex+decode` catches obfuscated
 * payloads that the regex-only engine misses.
 */

/** A decoded candidate plus which technique produced it (for diagnostics/tests). */
export interface DecodeResult {
  candidate: string;
  via: 'base64-pipeline' | 'base64-blob' | 'hex-escape' | 'var-indirection';
}

/** Matches a plausible base64 token: length >= 8, multiple of 4, base64 alphabet. */
const BASE64_TOKEN = /[A-Za-z0-9+/]{8,}={0,2}/g;

/** Detects an explicit base64-decode pipeline in the command. */
const BASE64_PIPELINE = /base64\s+(?:-d|--decode|-D)\b/;

function isPrintable(s: string): boolean {
  // Decoded shell payloads should be printable ASCII (allow tab/newline).
  return /^[\t\n\x20-\x7e]*$/.test(s) && s.length > 0;
}

function tryBase64(token: string): string | null {
  // Must be a multiple of 4 to be valid (padding included).
  if (token.length % 4 !== 0) return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    // Reject round-trip mismatches (Buffer is lenient): only accept clean decodes.
    if (Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') !==
      token.replace(/=+$/, '')) {
      return null;
    }
    return isPrintable(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Decode base64 — both explicit pipelines and bare blobs that decode cleanly. */
function decodeBase64(command: string): DecodeResult[] {
  const out: DecodeResult[] = [];
  const hasPipeline = BASE64_PIPELINE.test(command);
  const tokens = command.match(BASE64_TOKEN) ?? [];
  for (const token of tokens) {
    const decoded = tryBase64(token);
    if (decoded === null) continue;
    // Substitute the decoded payload back into the command so a downstream pipe
    // (e.g. "| sh") is preserved and the decoded command is also offered standalone.
    out.push({
      candidate: command.replace(token, decoded),
      via: hasPipeline ? 'base64-pipeline' : 'base64-blob',
    });
    out.push({ candidate: decoded, via: hasPipeline ? 'base64-pipeline' : 'base64-blob' });
  }
  return out;
}

/** Decode \xNN and $'\xNN' hex escape sequences. */
function decodeHex(command: string): DecodeResult[] {
  if (!/\\x[0-9a-fA-F]{2}/.test(command)) return [];
  const replaced = command.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  if (replaced === command || !isPrintable(replaced)) return [];
  // Strip ANSI-C $'...' wrapping that becomes plain text after decode.
  const unwrapped = replaced.replace(/\$'([^']*)'/g, '$1');
  const results: DecodeResult[] = [{ candidate: replaced, via: 'hex-escape' }];
  if (unwrapped !== replaced) results.push({ candidate: unwrapped, via: 'hex-escape' });
  return results;
}

/**
 * Resolve simple `VAR=value` assignments and substitute `$VAR` / `${VAR}` references.
 * Handles multi-hop (A=rm; B=-rf; $A $B /) within a single command line.
 */
function decodeVarIndirection(command: string): DecodeResult[] {
  // Only act if there's both an assignment and a reference.
  if (!/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(command)) return [];

  const assignments = new Map<string, string>();
  // Match VAR=value (value = non-space, non-semicolon run). Stops at ; or whitespace.
  const ASSIGN = /\b([A-Za-z_][A-Za-z0-9_]*)=([^\s;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = ASSIGN.exec(command)) !== null) {
    assignments.set(m[1], m[2]);
  }
  if (assignments.size === 0) return [];

  // Substitute references, iterating to a fixpoint for multi-hop chains.
  let resolved = command;
  for (let i = 0; i < 8; i++) {
    let changed = false;
    for (const [name, value] of assignments) {
      const ref = new RegExp(`\\$\\{${name}\\}|\\$${name}\\b`, 'g');
      const next = resolved.replace(ref, value);
      if (next !== resolved) {
        resolved = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (resolved === command) return [];

  // Strip the now-redundant leading assignments so the substituted command is exposed
  // as a clean candidate (e.g. "X=rm; rm -rf /" -> "rm -rf /").
  const stripped = resolved
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*=[^\s;]+\s*;?\s*/g, '')
    .trim();

  const results: DecodeResult[] = [{ candidate: resolved, via: 'var-indirection' }];
  if (stripped && stripped !== resolved) {
    results.push({ candidate: stripped, via: 'var-indirection' });
  }
  return results;
}

/**
 * Produce all decoded candidate strings for a command. Applies each technique to the
 * original command and also re-applies them to first-pass results (so a base64 blob that
 * decodes into a var-indirection payload is still caught). Deduplicated; excludes the
 * original input (caller already scans that).
 */
export function decodeCommand(command: string): DecodeResult[] {
  const seen = new Set<string>([command]);
  const out: DecodeResult[] = [];

  const apply = (cmd: string): DecodeResult[] => [
    ...decodeBase64(cmd),
    ...decodeHex(cmd),
    ...decodeVarIndirection(cmd),
  ];

  // First pass over the original.
  const firstPass = apply(command);
  for (const r of firstPass) {
    if (seen.has(r.candidate)) continue;
    seen.add(r.candidate);
    out.push(r);
  }

  // Second pass: re-decode first-pass candidates (handles nested obfuscation).
  for (const r of [...out]) {
    for (const r2 of apply(r.candidate)) {
      if (seen.has(r2.candidate)) continue;
      seen.add(r2.candidate);
      out.push({ candidate: r2.candidate, via: r2.via });
    }
  }

  return out;
}

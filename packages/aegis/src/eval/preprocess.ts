/**
 * Decode-then-rescan preprocessing for obfuscated shell commands.
 *
 * Detects encoding/obfuscation patterns in a shell command, attempts to decode
 * them, and returns the union of the original string plus any successfully
 * decoded variants. The evaluator then runs the full rule corpus against ALL
 * strings — if any string trips a rule, the evaluation reflects it.
 *
 * Supported patterns (Phase 1):
 *   - base64 piped to shell:  echo <b64> | base64 -d | sh/bash/zsh
 *   - base64 decode inline:   base64 -d <<< <b64>
 *   - hex-escaped payload:    \x72\x6d ... (hex-encoded chars)
 *
 * Design: extractDecodedVariants() is pure — no throws, no side effects. If
 * decoding fails (bad padding, non-UTF-8, etc.) the variant is silently dropped
 * and only the original string is returned.
 */

/** Regex: `echo <b64> | base64 -d | (bash|sh|zsh|...)` */
const BASE64_PIPE_TO_SHELL =
  /echo\s+([A-Za-z0-9+/=]+)\s*\|[^|]*base64\s+-d\s*\|/i;

/** Regex: `base64 -d <<< <b64>` or `base64 --decode <<< <b64>` */
const BASE64_HERESTRING = /base64\s+(?:-d|--decode)\s+<<<\s+([A-Za-z0-9+/=]+)/i;

/** Regex: `$( base64 -d <<< <b64> )` subshell variant */
const BASE64_SUBSHELL_DECODE =
  /\$\(\s*(?:echo\s+)?([A-Za-z0-9+/=]+)\s*\|\s*base64\s+-d\s*\)/i;

/** Hex-escape sequence: sequences of `\xHH` */
const HEX_ESCAPE_SEQ = /(?:\\x[0-9a-fA-F]{2}){4,}/g;

function tryBase64Decode(b64: string): string | null {
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    // Reject if it looks like binary noise (non-printable chars dominate)
    const printable = decoded.replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g, '');
    if (printable.length < decoded.length * 0.8) return null;
    return decoded.trim();
  } catch {
    return null;
  }
}

function tryHexDecode(hexSeq: string): string | null {
  try {
    const bytes = hexSeq.match(/\\x([0-9a-fA-F]{2})/g);
    if (!bytes) return null;
    const decoded = Buffer.from(bytes.map((b) => parseInt(b.slice(2), 16))).toString('utf8');
    return decoded.trim();
  } catch {
    return null;
  }
}

/**
 * Given a shell command string, return an array containing the original string
 * plus any successfully decoded variants. Always includes the original.
 *
 * Callers should run the rule corpus against every element in the result.
 */
export function extractDecodedVariants(command: string): string[] {
  const variants: string[] = [command];

  // base64 | shell pattern
  const m1 = BASE64_PIPE_TO_SHELL.exec(command);
  if (m1) {
    const decoded = tryBase64Decode(m1[1]);
    if (decoded && !variants.includes(decoded)) variants.push(decoded);
  }

  // base64 -d <<< pattern
  const m2 = BASE64_HERESTRING.exec(command);
  if (m2) {
    const decoded = tryBase64Decode(m2[1]);
    if (decoded && !variants.includes(decoded)) variants.push(decoded);
  }

  // $( ... | base64 -d ) subshell pattern
  const m3 = BASE64_SUBSHELL_DECODE.exec(command);
  if (m3) {
    const decoded = tryBase64Decode(m3[1]);
    if (decoded && !variants.includes(decoded)) variants.push(decoded);
  }

  // hex escape sequences
  const hexMatches = command.match(HEX_ESCAPE_SEQ);
  if (hexMatches) {
    for (const seq of hexMatches) {
      const decoded = tryHexDecode(seq);
      if (decoded && !variants.includes(decoded)) variants.push(decoded);
    }
  }

  return variants;
}

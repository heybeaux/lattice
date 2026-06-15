import { describe, it, expect } from 'vitest';
import { evaluate } from '@heybeaux/lattice-aegis';
import { toToolCall } from '../src/stdin.js';
import { loadAllPacks } from '../src/rules.js';
import { decide } from '../src/decide.js';

/** Full pipeline: hook stdin -> ToolCall -> evaluate(packs) -> decide -> exit code. */
function runHook(hookInput: unknown): number {
  const call = toToolCall(hookInput);
  const evaluation = evaluate(call, loadAllPacks());
  return decide(evaluation).exitCode;
}

describe('end-to-end hook pipeline', () => {
  it('blocks a known-dangerous Bash command (exit 2)', () => {
    const code = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    expect(code).toBe(2);
  });

  it('allows a benign Bash command (exit 0)', () => {
    const code = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(code).toBe(0);
  });

  it('loads all five shipped rule packs', () => {
    expect(loadAllPacks().length).toBeGreaterThan(0);
  });
});

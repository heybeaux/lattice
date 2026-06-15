import { describe, it, expect } from 'vitest';
import { decide } from '../src/decide.js';
import type { Evaluation } from '@heybeaux/lattice-aegis';

function ev(action: Evaluation['action'], reason: string): Evaluation {
  return {
    action,
    decidedBy: 'severity',
    matches: [],
    reason,
    ruleVersions: [],
  };
}

describe('decide', () => {
  it('deny -> exit 2 with the reason on stderr', () => {
    const d = decide(ev('deny', 'rm -rf /'));
    expect(d.exitCode).toBe(2);
    expect(d.stderr).toContain('rm -rf /');
    expect(d.stderr).toContain('DENY');
  });

  it('ask -> exit 0 with an advisory on stderr (degrades to allow-with-warning)', () => {
    const d = decide(ev('ask', 'git push --force'));
    expect(d.exitCode).toBe(0);
    expect(d.stderr).toContain('git push --force');
    expect(d.stderr).toContain('ASK');
  });

  it('allow -> exit 0 with empty stderr', () => {
    const d = decide(ev('allow', ''));
    expect(d.exitCode).toBe(0);
    expect(d.stderr).toBe('');
  });
});

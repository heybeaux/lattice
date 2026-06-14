import { describe, it, expect } from 'vitest';
import { loadPack } from '../src/rules/loader.js';
import { mergeLayers } from '../src/rules/merge.js';
import { evaluate } from '../src/eval/evaluate.js';
import { isSafeCommand } from '../src/eval/safe-command.js';
import type { Rule, RulePack } from '../src/types.js';

const rmRf: Rule = {
  id: 'bash.rm-rf-root',
  category: 'bash',
  severity: 'critical',
  description: 'rm -rf / — recursive force-delete from root',
  match: {
    kind: 'regex',
    pattern: '\\brm\\s+-[^\\s]*r[^\\s]*f[^\\s]*\\s+/',
    flags: 'i',
    target: 'command',
  },
  appliesTo: ['Bash'],
};

const forcePush: Rule = {
  id: 'bash.git-force-push',
  category: 'bash',
  severity: 'high',
  description: 'git push --force — destructive remote rewrite',
  match: {
    kind: 'regex',
    pattern: '\\bgit\\s+push\\s+.*--force\\b',
    target: 'command',
  },
  appliesTo: ['Bash'],
};

const pack: RulePack = {
  packId: 'aegis-test',
  version: '1.0.0',
  rules: [rmRf, forcePush],
};

describe('loader', () => {
  it('compiles a valid pack', () => {
    const compiled = loadPack(pack);
    expect(compiled).toHaveLength(2);
    expect(compiled[0].regex).toBeInstanceOf(RegExp);
  });

  it('rejects the g flag', () => {
    const bad: RulePack = {
      packId: 'bad',
      version: '1.0.0',
      rules: [{ ...rmRf, match: { ...rmRf.match, flags: 'g' } }],
    };
    expect(() => loadPack(bad)).toThrow(/disallowed regex flag 'g'/);
  });

  it('rejects duplicate ids', () => {
    const dup: RulePack = { packId: 'dup', version: '1.0.0', rules: [rmRf, rmRf] };
    expect(() => loadPack(dup)).toThrow(/duplicate rule id/);
  });
});

describe('evaluate — severity floor', () => {
  const compiled = loadPack(pack);

  it('denies a critical match', () => {
    const r = evaluate({ tool: 'Bash', command: 'rm -rf /' }, compiled);
    expect(r.action).toBe('deny');
    expect(r.decidedBy).toBe('severity');
    expect(r.matches.map((m) => m.id)).toContain('bash.rm-rf-root');
  });

  it('asks on a high match', () => {
    const r = evaluate({ tool: 'Bash', command: 'git push origin main --force' }, compiled);
    expect(r.action).toBe('ask');
  });

  it('allows a clean command', () => {
    const r = evaluate({ tool: 'Bash', command: 'ls -la' }, compiled);
    expect(r.action).toBe('allow');
    expect(r.matches).toHaveLength(0);
  });

  it('does not apply a Bash rule to a Read tool', () => {
    const r = evaluate({ tool: 'Read', command: 'rm -rf /' }, compiled);
    expect(r.action).toBe('allow');
  });
});

describe('evaluate — prediction overlay can only escalate', () => {
  const compiled = loadPack(pack);

  it('escalates allow -> ask on high P(failure)', () => {
    const r = evaluate({ tool: 'Bash', command: 'ls -la' }, compiled, {
      prediction: { pFailure: 0.5, confidence: 0.7, source: 'awm' },
    });
    expect(r.action).toBe('ask');
    expect(r.decidedBy).toBe('prediction');
  });

  it('escalates allow -> deny on very high P(failure)', () => {
    const r = evaluate({ tool: 'Bash', command: 'ls -la' }, compiled, {
      prediction: { pFailure: 0.95, confidence: 0.7, source: 'awm' },
    });
    expect(r.action).toBe('deny');
  });

  it('CANNOT relax a critical match even with low P(failure)', () => {
    const r = evaluate({ tool: 'Bash', command: 'rm -rf /' }, compiled, {
      prediction: { pFailure: 0.01, confidence: 0.9, source: 'awm' },
    });
    expect(r.action).toBe('deny');
  });
});

describe('mergeLayers — strictness invariant', () => {
  it('lets an overlay add a new rule', () => {
    const extra: Rule = { ...forcePush, id: 'bash.sudo', severity: 'high', description: 'sudo' };
    const { rules } = mergeLayers([[rmRf], [extra]]);
    expect(rules.map((r) => r.id).sort()).toEqual(['bash.rm-rf-root', 'bash.sudo']);
  });

  it('lets an overlay TIGHTEN freely', () => {
    const tighten: Rule = { ...forcePush, severity: 'critical' };
    const { rules, warnings } = mergeLayers([[forcePush], [tighten]]);
    expect(rules.find((r) => r.id === forcePush.id)?.severity).toBe('critical');
    expect(warnings).toHaveLength(0);
  });

  it('refuses a silent downgrade and keeps the stricter builtin', () => {
    const weaken: Rule = { ...rmRf, severity: 'low' };
    const { rules, warnings } = mergeLayers([[rmRf], [weaken]]);
    expect(rules.find((r) => r.id === rmRf.id)?.severity).toBe('critical');
    expect(warnings).toHaveLength(1);
  });

  it('allows a downgrade when allowDowngrade is set', () => {
    const weaken: Rule = { ...rmRf, severity: 'low', allowDowngrade: true };
    const { rules, warnings } = mergeLayers([[rmRf], [weaken]]);
    expect(rules.find((r) => r.id === rmRf.id)?.severity).toBe('low');
    expect(warnings).toHaveLength(0);
  });
});

describe('isSafeCommand', () => {
  it('fast-paths a bare allowlisted command', () => {
    expect(isSafeCommand('ls -la')).toBe(true);
  });

  it('refuses anything with a combinator', () => {
    expect(isSafeCommand('ls && rm -rf /')).toBe(false);
    expect(isSafeCommand('cat x | sh')).toBe(false);
    expect(isSafeCommand('echo $(rm -rf /)')).toBe(false);
  });

  it('is word-boundary aware (catastrophe != cat)', () => {
    expect(isSafeCommand('catastrophe')).toBe(false);
  });
});

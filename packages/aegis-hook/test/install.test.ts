import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHookConfig, mergeIntoSettings, installHook } from '../src/install.js';

describe('buildHookConfig', () => {
  it('produces the EXACT correct nested Claude Code schema (anti-AutoHarness)', () => {
    const fragment = buildHookConfig({ command: 'node /abs/path/to/dist/cli.js' });
    // Deep-assert the whole structure: PreToolUse is an array of { matcher, hooks:[{type,command}] }.
    expect(fragment).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|Write|Edit|Read',
            hooks: [{ type: 'command', command: 'node /abs/path/to/dist/cli.js' }],
          },
        ],
      },
    });
  });

  it('honors a custom matcher', () => {
    const fragment = buildHookConfig({ command: 'node x.js', matcher: 'Bash' });
    expect(fragment.hooks.PreToolUse[0]!.matcher).toBe('Bash');
  });

  it('is NOT the broken flat AutoHarness shape', () => {
    const fragment = buildHookConfig({ command: 'node x.js' });
    const entry = fragment.hooks.PreToolUse[0]!;
    // The flat-shape bug: { type, command } at the matcher level. It must NOT exist.
    expect(entry).not.toHaveProperty('type');
    expect(entry).not.toHaveProperty('command');
    expect(Array.isArray(entry.hooks)).toBe(true);
    expect(entry.hooks[0]).toEqual({ type: 'command', command: 'node x.js' });
  });
});

describe('mergeIntoSettings', () => {
  it('appends to PreToolUse without clobbering an existing unrelated hook', () => {
    const existing = {
      model: 'opus',
      hooks: {
        PreToolUse: [
          { matcher: 'Grep', hooks: [{ type: 'command' as const, command: 'node other.js' }] },
        ],
        PostToolUse: [
          { matcher: '*', hooks: [{ type: 'command' as const, command: 'node post.js' }] },
        ],
      },
    };
    const fragment = buildHookConfig({ command: 'node /abs/dist/cli.js' });
    const merged = mergeIntoSettings(existing, fragment);

    // Unrelated top-level key preserved.
    expect(merged.model).toBe('opus');
    // Unrelated event preserved untouched.
    expect(merged.hooks?.PostToolUse).toEqual(existing.hooks.PostToolUse);
    // Existing PreToolUse matcher preserved, ours appended after it.
    expect(merged.hooks?.PreToolUse).toEqual([
      { matcher: 'Grep', hooks: [{ type: 'command', command: 'node other.js' }] },
      {
        matcher: 'Bash|Write|Edit|Read',
        hooks: [{ type: 'command', command: 'node /abs/dist/cli.js' }],
      },
    ]);
    // Inputs not mutated.
    expect(existing.hooks.PreToolUse).toHaveLength(1);
  });

  it('creates PreToolUse when settings has no hooks at all', () => {
    const merged = mergeIntoSettings({}, buildHookConfig({ command: 'node x.js' }));
    expect(merged.hooks?.PreToolUse).toHaveLength(1);
    expect(merged.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash|Write|Edit|Read');
  });

  it('is idempotent: re-merging the same command does NOT stack a duplicate', () => {
    const frag = buildHookConfig({ command: 'node /abs/dist/cli.js' });
    const once = mergeIntoSettings({}, frag);
    const twice = mergeIntoSettings(once, frag);
    expect(twice.hooks?.PreToolUse).toHaveLength(1);
  });
});

describe('installHook (disk)', () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'aegis-hook-'));
  }

  it('MERGES into a populated PreToolUse without clobbering existing matchers', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    // Mirror the user's real settings shape: two claude-flow matchers + other keys.
    const original = {
      env: { CLAUDE_FLOW_HOOKS_ENABLED: 'true' },
      permissions: { allow: ['Bash(node:*)'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx claude-flow pre-command' }] },
          {
            matcher: 'Write|Edit|MultiEdit',
            hooks: [{ type: 'command', command: 'npx claude-flow pre-edit' }],
          },
        ],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'log' }] }],
      },
    };
    writeFileSync(path, JSON.stringify(original, null, 2), 'utf8');

    const res = installHook({ settingsPath: path, command: 'node /abs/dist/cli.js' });
    expect(res.added).toBe(true);
    expect(res.backupPath).toBeDefined();
    expect(existsSync(res.backupPath!)).toBe(true);

    const written = JSON.parse(readFileSync(path, 'utf8'));
    // The two original matchers are STILL present, in order.
    expect(written.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('npx claude-flow pre-command');
    expect(written.hooks.PreToolUse[1].matcher).toBe('Write|Edit|MultiEdit');
    // Ours appended at the end.
    expect(written.hooks.PreToolUse[2]).toEqual({
      matcher: 'Bash|Write|Edit|Read',
      hooks: [{ type: 'command', command: 'node /abs/dist/cli.js' }],
    });
    // Unrelated keys + events untouched.
    expect(written.env.CLAUDE_FLOW_HOOKS_ENABLED).toBe('true');
    expect(written.permissions.allow).toEqual(['Bash(node:*)']);
    expect(written.hooks.PostToolUse).toEqual(original.hooks.PostToolUse);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent on disk: a second install does not add a duplicate', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({}, null, 2), 'utf8');
    installHook({ settingsPath: path, command: 'node /abs/dist/cli.js' });
    const second = installHook({ settingsPath: path, command: 'node /abs/dist/cli.js' });
    expect(second.added).toBe(false);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.hooks.PreToolUse).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a fresh settings.json when none exists (no backup)', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    const res = installHook({ settingsPath: path, command: 'node x.js' });
    expect(res.added).toBe(true);
    expect(res.backupPath).toBeUndefined();
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('REFUSES to overwrite an unparseable settings file (no clobber)', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{ this is not valid json ', 'utf8');
    expect(() => installHook({ settingsPath: path, command: 'node x.js' })).toThrow(
      /could not read existing/,
    );
    // Original bytes are untouched.
    expect(readFileSync(path, 'utf8')).toBe('{ this is not valid json ');
    rmSync(dir, { recursive: true, force: true });
  });
});

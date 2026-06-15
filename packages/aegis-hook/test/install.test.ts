import { describe, it, expect } from 'vitest';
import { buildHookConfig, mergeIntoSettings } from '../src/install.js';

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
});

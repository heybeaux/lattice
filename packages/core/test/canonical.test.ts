import { describe, it, expect, vi } from 'vitest';
import { canonicalize, CanonicalMemo } from '../src/util/canonical.js';

// ─── #11: serializeValue must not mutate caller arrays ───

describe('canonicalize() — non-mutation guarantee (issue #11)', () => {
  it('does not mutate top-level arrays', () => {
    const arr = [3, 1, 2];
    const before = JSON.parse(JSON.stringify(arr));
    canonicalize(arr);
    expect(arr).toEqual(before);
  });

  it('does not mutate arrays nested inside objects', () => {
    const input = {
      ids: [9, 4, 7],
      meta: { tags: ['z', 'a', 'm'], nums: [3, 1, 2] },
    };
    const before = JSON.parse(JSON.stringify(input));
    canonicalize(input);
    expect(input).toEqual(before);
  });

  it('does not mutate objects (key order is preserved on the input)', () => {
    const input = { z: 1, a: 2, m: { y: 1, x: 2 } };
    const topKeysBefore = Object.keys(input);
    const nestedKeysBefore = Object.keys(input.m);
    canonicalize(input);
    expect(Object.keys(input)).toEqual(topKeysBefore);
    expect(Object.keys(input.m)).toEqual(nestedKeysBefore);
  });

  it('does not mutate deeply nested mixed structures', () => {
    const input = {
      outer: {
        list: [
          { b: 2, a: 1 },
          { d: 4, c: 3 },
        ],
        meta: { z: { y: 1, x: 2 }, a: 9 },
      },
    };
    const before = structuredClone(input);
    canonicalize(input);
    expect(input).toEqual(before);
    // Spot-check that nested object key orders are unchanged.
    expect(Object.keys(input.outer.list[0])).toEqual(['b', 'a']);
    expect(Object.keys(input.outer.meta.z)).toEqual(['y', 'x']);
  });
});

// ─── #12: keys must be sorted at every depth ───

describe('canonicalize() — recursive key ordering (issue #12)', () => {
  it('produces equal output for top-level reordering', () => {
    const a = { foo: 1, bar: 2 };
    const b = { bar: 2, foo: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('produces equal output for nested reordering', () => {
    const a = { outer: { x: 1, y: 2 } };
    const b = { outer: { y: 2, x: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('commutes over key reordering at every depth', () => {
    const v1 = {
      z: { c: 1, b: 2, a: 3 },
      a: { z: 9, y: 8, x: { q: 1, p: 2 } },
      m: [
        { mb: 'b', ma: 'a' },
        { mz: 'z', my: 'y' },
      ],
    };
    const v2 = {
      a: { x: { p: 2, q: 1 }, y: 8, z: 9 },
      m: [
        { ma: 'a', mb: 'b' },
        { my: 'y', mz: 'z' },
      ],
      z: { a: 3, b: 2, c: 1 },
    };
    expect(canonicalize(v1)).toBe(canonicalize(v2));
  });

  it('preserves array element order (arrays are sequence types)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    // Two arrays with same elements in different order are NOT equal.
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('handles primitives and edge cases', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(undefined)).toBe('undefined');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize(NaN)).toBe('null'); // matches JSON.stringify
    expect(canonicalize(Infinity)).toBe('null');
  });

  it('drops undefined / function / symbol values inside objects (matches JSON.stringify)', () => {
    const input: any = { keep: 1, drop1: undefined, drop2: () => 0, drop3: Symbol('x') };
    expect(canonicalize(input)).toBe('{"keep":1}');
  });
});

// ─── CanonicalMemo: same reference returns the same string ───

describe('CanonicalMemo', () => {
  it('returns identical canonical strings for the same reference', () => {
    const memo = new CanonicalMemo();
    const obj = { z: 1, a: 2, nested: { y: 1, x: 2 } };
    const first = canonicalize(obj, memo);
    const second = canonicalize(obj, memo);
    expect(first).toBe(second);
  });

  it('caches sub-objects shared across multiple top-level canonicalizations', () => {
    const memo = new CanonicalMemo();
    const shared = { z: 1, a: 2 };
    const left = { name: 'left', payload: shared };
    const right = { name: 'right', payload: shared };

    canonicalize(left, memo);
    // After the first pass, the shared sub-object's canonical form is cached.
    expect(memo.get(shared)).toBe('{"a":2,"z":1}');
    // Second pass reuses the memo entry (no observable difference, but the
    // cached value remains correct).
    canonicalize(right, memo);
    expect(memo.get(shared)).toBe('{"a":2,"z":1}');
  });
});
